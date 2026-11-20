use crate::models::{ProcessEntry, ProcessRule, RuleAlertEvent};
use crate::process_ops;
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const ALERT_COOLDOWN: Duration = Duration::from_secs(60);

pub struct RuleStore {
    file_path: Option<PathBuf>,
    rules: Vec<ProcessRule>,
    by_name: HashMap<String, ProcessRule>,
    applied_pids: HashSet<(String, u32)>,
    alert_cooldowns: HashMap<(String, u32), Instant>,
}

impl RuleStore {
    pub fn load(file_path: Option<PathBuf>) -> Self {
        let rules = file_path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|raw| serde_json::from_str::<Vec<ProcessRule>>(&raw).ok())
            .unwrap_or_default();

        let mut store = Self {
            file_path,
            rules,
            by_name: HashMap::new(),
            applied_pids: HashSet::new(),
            alert_cooldowns: HashMap::new(),
        };
        store.rebuild_index();
        store
    }

    fn rebuild_index(&mut self) {
        self.by_name.clear();
        for rule in &self.rules {
            if rule.enabled {
                let key = rule.process_name.trim().to_lowercase();
                if !key.is_empty() {
                    self.by_name.insert(key, rule.clone());
                }
            }
        }
    }

    fn persist(&self) -> Result<(), String> {
        let Some(ref path) = self.file_path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(&self.rules)
            .map_err(|e| format!("Regeln konnten nicht serialisiert werden: {e}"))?;
        std::fs::write(path, json)
            .map_err(|e| format!("Regeln konnten nicht gespeichert werden: {e}"))
    }

    pub fn list(&self) -> Vec<ProcessRule> {
        self.rules.clone()
    }

    pub fn save_rule(&mut self, mut rule: ProcessRule) -> Result<Vec<ProcessRule>, String> {
        rule.process_name = rule.process_name.trim().to_string();
        if rule.process_name.is_empty() {
            return Err("Prozessname darf nicht leer sein.".into());
        }
        if rule.id.trim().is_empty() {
            rule.id = format!("rule-{}", Utc::now().timestamp_millis());
        }

        // Reset applied state for this rule so updated settings take effect
        self.applied_pids.retain(|(rid, _)| rid != &rule.id);

        if let Some(existing) = self.rules.iter_mut().find(|r| r.id == rule.id) {
            *existing = rule;
        } else {
            self.rules.push(rule);
        }

        self.rebuild_index();
        self.persist()?;
        Ok(self.rules.clone())
    }

    pub fn delete_rule(&mut self, id: &str) -> Result<Vec<ProcessRule>, String> {
        self.rules.retain(|r| r.id != id);
        self.applied_pids.retain(|(rid, _)| rid != id);
        self.alert_cooldowns.retain(|(rid, _), _| rid != id);
        self.rebuild_index();
        self.persist()?;
        Ok(self.rules.clone())
    }

    /// Evaluates active rules against the current process list.
    /// Zero overhead when no enabled rules exist.
    pub fn evaluate(&mut self, processes: &[ProcessEntry]) -> Vec<RuleAlertEvent> {
        if self.by_name.is_empty() {
            return Vec::new();
        }

        let active_pids: HashSet<u32> = processes.iter().map(|p| p.pid).collect();
        self.applied_pids.retain(|(_, pid)| active_pids.contains(pid));
        self.alert_cooldowns
            .retain(|(_, pid), _| active_pids.contains(pid));

        let self_pid = std::process::id();
        let now = Instant::now();
        let now_ts = Utc::now().timestamp_millis() as u64;
        let mut alerts = Vec::new();

        for proc_ in processes {
            if proc_.pid == self_pid || proc_.pid <= 4 {
                continue;
            }
            let key = proc_.name.to_lowercase();
            let Some(rule) = self.by_name.get(&key) else {
                continue;
            };

            // Apply priority / eco_mode / affinity_mask once per newly seen PID
            let applied_key = (rule.id.clone(), proc_.pid);
            if !self.applied_pids.contains(&applied_key) {
                if let Some(ref prio) = rule.priority {
                    if !prio.is_empty() {
                        let _ = process_ops::set_process_priority(proc_.pid, prio);
                    }
                }
                if let Some(eco) = rule.eco_mode {
                    let _ = process_ops::set_efficiency_mode(proc_.pid, eco);
                }
                if let Some(mask) = rule.affinity_mask {
                    if mask > 0 {
                        let _ = process_ops::set_process_affinity(proc_.pid, mask);
                    }
                }
                self.applied_pids.insert(applied_key.clone());
            }

            // Evaluate alert thresholds with 60s cooldown per (rule_id, pid)
            let mut trigger_msg: Option<String> = None;
            if let Some(cpu_limit) = rule.alert_cpu_pct {
                if cpu_limit > 0.0 && proc_.cpu_percent >= cpu_limit {
                    trigger_msg = Some(format!(
                        "{} (PID {}) überschreitet CPU-Limit: {:.1}% (Limit {:.0}%)",
                        proc_.name, proc_.pid, proc_.cpu_percent, cpu_limit
                    ));
                }
            }
            if trigger_msg.is_none() {
                if let Some(ram_limit_mb) = rule.alert_ram_mb {
                    let ram_mb = proc_.memory_bytes / (1024 * 1024);
                    if ram_limit_mb > 0 && ram_mb >= ram_limit_mb {
                        trigger_msg = Some(format!(
                            "{} (PID {}) überschreitet RAM-Limit: {} MB (Limit {} MB)",
                            proc_.name, proc_.pid, ram_mb, ram_limit_mb
                        ));
                    }
                }
            }

            if let Some(message) = trigger_msg {
                let on_cooldown = self
                    .alert_cooldowns
                    .get(&applied_key)
                    .map(|last| now.duration_since(*last) < ALERT_COOLDOWN)
                    .unwrap_or(false);
                if !on_cooldown {
                    self.alert_cooldowns.insert(applied_key, now);
                    alerts.push(RuleAlertEvent {
                        rule_id: rule.id.clone(),
                        process_name: proc_.name.clone(),
                        pid: proc_.pid,
                        message,
                        timestamp: now_ts,
                    });
                }
            }
        }

        alerts
    }
}
