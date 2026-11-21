use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuMetrics {
    pub total_usage: f32,
    pub per_core: Vec<f32>,
    #[serde(default)]
    pub per_core_frequency_mhz: Vec<u64>,
    pub brand: String,
    pub frequency_mhz: u64,
    #[serde(default)]
    pub base_frequency_mhz: u64,
    pub physical_cores: usize,
    pub logical_cores: usize,
    pub temperature_c: Option<f32>,
    #[serde(default)]
    pub power_watts: Option<f32>,
    #[serde(default)]
    pub sensor_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetrics {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub cached_bytes: u64,
    pub usage_percent: f32,
    pub swap_used_bytes: u64,
    pub swap_total_bytes: u64,
    #[serde(default)]
    pub commit_total_bytes: u64,
    #[serde(default)]
    pub commit_limit_bytes: u64,
    #[serde(default)]
    pub paged_pool_bytes: u64,
    #[serde(default)]
    pub non_paged_pool_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuMetrics {
    pub name: String,
    pub vendor: String,
    pub usage_percent: Option<f32>,
    pub vram_used_bytes: u64,
    pub vram_total_bytes: u64,
    #[serde(default)]
    pub shared_used_bytes: u64,
    #[serde(default)]
    pub shared_total_bytes: u64,
    pub temperature_c: Option<f32>,
    pub power_watts: Option<f32>,
    #[serde(default)]
    pub power_limit_watts: Option<f32>,
    #[serde(default)]
    pub clock_mhz: Option<u32>,
    #[serde(default)]
    pub memory_clock_mhz: Option<u32>,
    #[serde(default)]
    pub fan_speed_percent: Option<u32>,
    #[serde(default)]
    pub engine_3d_percent: f32,
    #[serde(default)]
    pub engine_copy_percent: f32,
    #[serde(default)]
    pub engine_video_encode_percent: f32,
    #[serde(default)]
    pub engine_video_decode_percent: f32,
    #[serde(default)]
    pub driver_version: Option<String>,
    #[serde(default)]
    pub driver_date: Option<String>,
    #[serde(default)]
    pub pci_location: Option<String>,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDriveInfo {
    pub name: String,
    pub mount_point: String,
    pub file_system: String,
    pub kind: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub bus_type: Option<String>,
    #[serde(default)]
    pub is_system_drive: bool,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub usage_percent: f32,
    #[serde(default)]
    pub active_percent: f32,
    #[serde(default)]
    pub avg_response_ms: f32,
    #[serde(default)]
    pub read_bytes_per_sec: u64,
    #[serde(default)]
    pub write_bytes_per_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskMetrics {
    pub read_bytes_per_sec: u64,
    pub write_bytes_per_sec: u64,
    #[serde(default)]
    pub active_percent: f32,
    #[serde(default)]
    pub avg_response_ms: f32,
    pub drives: Vec<DiskDriveInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceInfo {
    pub name: String,
    pub ip_addresses: Vec<String>,
    pub mac_address: String,
    pub rx_bytes_per_sec: u64,
    pub tx_bytes_per_sec: u64,
    pub total_rx_bytes: u64,
    pub total_tx_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetrics {
    pub rx_bytes_per_sec: u64,
    pub tx_bytes_per_sec: u64,
    pub total_rx_bytes: u64,
    pub total_tx_bytes: u64,
    pub primary_interface: String,
    pub interfaces: Vec<NetworkInterfaceInfo>,
    #[serde(default)]
    pub per_process_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryMetrics {
    pub has_battery: bool,
    pub percent: Option<u8>,
    pub is_charging: bool,
    pub is_ac_plugged: bool,
    pub remaining_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSummary {
    pub hostname: String,
    pub os_name: String,
    pub uptime_seconds: u64,
    pub process_count: usize,
    pub listening_ports_count: usize,
    pub active_profile: String,
    pub profile_managed_count: usize,
    pub profile_boosted_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub group_key: String,
    pub subtitle: String,
    pub category: String,
    pub cpu_percent: f32,
    pub gpu_percent: f32,
    pub memory_bytes: u64,
    pub disk_read_bytes_per_sec: u64,
    pub disk_write_bytes_per_sec: u64,
    pub total_disk_read_bytes: u64,
    pub total_disk_write_bytes: u64,
    #[serde(default)]
    pub net_rx_bytes_per_sec: u64,
    #[serde(default)]
    pub net_tx_bytes_per_sec: u64,
    pub status: String,
    pub is_suspended: bool,
    pub is_efficiency_mode: bool,
    pub run_time_seconds: u64,
    pub exe_path: String,
    pub cmd_line: String,
    pub handle_count: Option<u32>,
    pub thread_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cpu_history: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameProcess {
    pub pid: u32,
    pub name: String,
    pub subtitle: String,
    pub category: String,
    pub cpu_percent: f32,
    pub gpu_percent: f32,
    pub memory_bytes: u64,
    pub disk_bytes_per_sec: u64,
    #[serde(default)]
    pub net_rx_bytes_per_sec: u64,
    #[serde(default)]
    pub net_tx_bytes_per_sec: u64,
    pub net_connections: u32,
    pub net_listening_ports: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub timestamp_ms: i64,
    pub cpu_percent: f32,
    pub ram_percent: f32,
    pub gpu_percent: f32,
    pub disk_mb_per_sec: f32,
    #[serde(default)]
    pub disk_active_percent: f32,
    pub net_kb_per_sec: f32,
    #[serde(default)]
    pub gpu_engine_3d: f32,
    #[serde(default)]
    pub gpu_engine_copy: f32,
    #[serde(default)]
    pub gpu_engine_encode: f32,
    #[serde(default)]
    pub gpu_engine_decode: f32,
    pub is_spike: bool,
    pub spike_reason: Option<String>,
    pub unaccounted_cpu_percent: f32,
    pub top_cpu: Vec<BlameProcess>,
    pub top_ram: Vec<BlameProcess>,
    pub top_gpu: Vec<BlameProcess>,
    pub top_disk: Vec<BlameProcess>,
    pub top_net: Vec<BlameProcess>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshot {
    pub timestamp_ms: i64,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub gpu: GpuMetrics,
    pub disk: DiskMetrics,
    pub network: NetworkMetrics,
    pub battery: BatteryMetrics,
    pub system: SystemSummary,
    pub processes: Vec<ProcessEntry>,
    pub latest_point: HistoryPoint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConnectionEntry {
    pub protocol: String,
    pub local_addr: String,
    pub local_port: u16,
    pub remote_addr: String,
    pub remote_port: u16,
    pub state: String,
    pub pid: u32,
    pub process_name: String,
    pub process_subtitle: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupEntry {
    pub id: String,
    pub name: String,
    pub command: String,
    pub location: String,
    pub scope: String,
    pub enabled: bool,
    pub registry_subkey: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEntry {
    pub name: String,
    pub display_name: String,
    pub status: String,
    pub pid: Option<u32>,
    #[serde(default)]
    pub start_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLockEntry {
    pub pid: u32,
    pub app_name: String,
    pub service_short_name: String,
    pub app_type: String,
    pub process_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuCoreInfo {
    pub index: u32,
    pub core_id: u32,
    pub efficiency_class: u8,
    pub is_p_core: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessAffinityInfo {
    pub pid: u32,
    pub process_mask: u64,
    pub system_mask: u64,
    pub cores: Vec<CpuCoreInfo>,
    pub has_hybrid_cores: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSecurityInfo {
    pub exe_path: String,
    pub sha256: String,
    pub file_size: u64,
    pub company_name: Option<String>,
    pub file_description: Option<String>,
    pub file_version: Option<String>,
    pub signed: bool,
    pub signature_status: String,
    pub virustotal_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessModuleEntry {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessThreadEntry {
    pub tid: u32,
    pub base_priority: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessModulesThreads {
    pub modules: Vec<ProcessModuleEntry>,
    pub threads: Vec<ProcessThreadEntry>,
    pub total_modules: usize,
    pub total_threads: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEnvInfo {
    pub cwd: Option<String>,
    pub env_vars: Vec<(String, String)>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRule {
    pub id: String,
    pub process_name: String,
    pub enabled: bool,
    pub priority: Option<String>,
    pub eco_mode: Option<bool>,
    pub affinity_mask: Option<u64>,
    pub alert_cpu_pct: Option<f32>,
    pub alert_ram_mb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleAlertEvent {
    pub rule_id: String,
    pub process_name: String,
    pub pid: u32,
    pub message: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartConfig {
    pub enabled: bool,
    /// "normal" | "maximized" | "minimized"
    pub mode: String,
}
