use crate::models::NetworkConnectionEntry;
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};

#[cfg(windows)]
pub fn list_connections(
    proc_lookup: &HashMap<u32, (String, String, String)>,
) -> Vec<NetworkConnectionEntry> {
    let mut result = Vec::new();
    result.extend(list_tcp_v4(proc_lookup));
    result.extend(list_tcp_v6(proc_lookup));
    result.extend(list_udp_v4(proc_lookup));
    result.extend(list_udp_v6(proc_lookup));

    // Sort: LISTENING first, then by port ascending
    result.sort_by(|a, b| {
        let a_listen = a.state == "LISTENING";
        let b_listen = b.state == "LISTENING";
        b_listen
            .cmp(&a_listen)
            .then_with(|| a.local_port.cmp(&b.local_port))
            .then_with(|| a.protocol.cmp(&b.protocol))
    });
    result
}

#[cfg(windows)]
fn tcp_state_name(state: u32) -> &'static str {
    match state {
        1 => "CLOSED",
        2 => "LISTENING",
        3 => "SYN_SENT",
        4 => "SYN_RCVD",
        5 => "ESTABLISHED",
        6 => "FIN_WAIT1",
        7 => "FIN_WAIT2",
        8 => "CLOSE_WAIT",
        9 => "CLOSING",
        10 => "LAST_ACK",
        11 => "TIME_WAIT",
        12 => "DELETE_TCB",
        _ => "UNKNOWN",
    }
}

#[cfg(windows)]
fn ntohs_u32(val: u32) -> u16 {
    u16::from_be((val & 0xFFFF) as u16)
}

#[cfg(windows)]
fn lookup_proc(
    proc_lookup: &HashMap<u32, (String, String, String)>,
    pid: u32,
) -> (String, String, String) {
    if pid == 0 {
        return ("System Idle".into(), String::new(), "system".into());
    }
    if pid == 4 {
        return ("System".into(), "Windows Kernel".into(), "system".into());
    }
    proc_lookup
        .get(&pid)
        .cloned()
        .unwrap_or_else(|| (format!("PID {pid}"), String::new(), "background".into()))
}

#[cfg(windows)]
fn list_tcp_v4(
    proc_lookup: &HashMap<u32, (String, String, String)>,
) -> Vec<NetworkConnectionEntry> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows::Win32::Networking::WinSock::AF_INET;

    let mut entries = Vec::new();
    unsafe {
        let mut size: u32 = 0;
        let _ = GetExtendedTcpTable(
            None,
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if size == 0 {
            return entries;
        }
        let mut buffer = vec![0u8; size as usize];
        let ret = GetExtendedTcpTable(
            Some(buffer.as_mut_ptr() as *mut _),
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if ret != 0 {
            return entries;
        }

        let table = &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
        let count = table.dwNumEntries as usize;
        let rows_ptr = table.table.as_ptr();
        let rows = std::slice::from_raw_parts(rows_ptr, count);

        for row in rows {
            let local_ip = Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).to_string();
            let remote_ip = Ipv4Addr::from(u32::from_be(row.dwRemoteAddr)).to_string();
            let local_port = ntohs_u32(row.dwLocalPort);
            let remote_port = ntohs_u32(row.dwRemotePort);
            let pid = row.dwOwningPid;
            let (name, subtitle, category) = lookup_proc(proc_lookup, pid);

            entries.push(NetworkConnectionEntry {
                protocol: "TCP".to_string(),
                local_addr: local_ip,
                local_port,
                remote_addr: remote_ip,
                remote_port,
                state: tcp_state_name(row.dwState).to_string(),
                pid,
                process_name: name,
                process_subtitle: subtitle,
                category,
            });
        }
        let _ = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
    }
    entries
}

#[cfg(windows)]
fn list_tcp_v6(
    proc_lookup: &HashMap<u32, (String, String, String)>,
) -> Vec<NetworkConnectionEntry> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6TABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows::Win32::Networking::WinSock::AF_INET6;

    let mut entries = Vec::new();
    unsafe {
        let mut size: u32 = 0;
        let _ = GetExtendedTcpTable(
            None,
            &mut size,
            false,
            AF_INET6.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if size == 0 {
            return entries;
        }
        let mut buffer = vec![0u8; size as usize];
        let ret = GetExtendedTcpTable(
            Some(buffer.as_mut_ptr() as *mut _),
            &mut size,
            false,
            AF_INET6.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if ret != 0 {
            return entries;
        }

        let table = &*(buffer.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
        let count = table.dwNumEntries as usize;
        let rows = std::slice::from_raw_parts(table.table.as_ptr(), count);

        for row in rows {
            let local_ip = Ipv6Addr::from(row.ucLocalAddr).to_string();
            let remote_ip = Ipv6Addr::from(row.ucRemoteAddr).to_string();
            let local_port = ntohs_u32(row.dwLocalPort);
            let remote_port = ntohs_u32(row.dwRemotePort);
            let pid = row.dwOwningPid;
            let (name, subtitle, category) = lookup_proc(proc_lookup, pid);

            entries.push(NetworkConnectionEntry {
                protocol: "TCPv6".to_string(),
                local_addr: local_ip,
                local_port,
                remote_addr: remote_ip,
                remote_port,
                state: tcp_state_name(row.dwState).to_string(),
                pid,
                process_name: name,
                process_subtitle: subtitle,
                category,
            });
        }
    }
    entries
}

#[cfg(windows)]
fn list_udp_v4(
    proc_lookup: &HashMap<u32, (String, String, String)>,
) -> Vec<NetworkConnectionEntry> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedUdpTable, MIB_UDPTABLE_OWNER_PID, UDP_TABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::AF_INET;

    let mut entries = Vec::new();
    unsafe {
        let mut size: u32 = 0;
        let _ = GetExtendedUdpTable(None, &mut size, false, AF_INET.0 as u32, UDP_TABLE_OWNER_PID, 0);
        if size == 0 {
            return entries;
        }
        let mut buffer = vec![0u8; size as usize];
        let ret = GetExtendedUdpTable(
            Some(buffer.as_mut_ptr() as *mut _),
            &mut size,
            false,
            AF_INET.0 as u32,
            UDP_TABLE_OWNER_PID,
            0,
        );
        if ret != 0 {
            return entries;
        }

        let table = &*(buffer.as_ptr() as *const MIB_UDPTABLE_OWNER_PID);
        let count = table.dwNumEntries as usize;
        let rows = std::slice::from_raw_parts(table.table.as_ptr(), count);

        for row in rows {
            let local_ip = Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).to_string();
            let local_port = ntohs_u32(row.dwLocalPort);
            let pid = row.dwOwningPid;
            let (name, subtitle, category) = lookup_proc(proc_lookup, pid);

            entries.push(NetworkConnectionEntry {
                protocol: "UDP".to_string(),
                local_addr: local_ip,
                local_port,
                remote_addr: "*".to_string(),
                remote_port: 0,
                state: "LISTENING".to_string(),
                pid,
                process_name: name,
                process_subtitle: subtitle,
                category,
            });
        }
    }
    entries
}

#[cfg(windows)]
fn list_udp_v6(
    proc_lookup: &HashMap<u32, (String, String, String)>,
) -> Vec<NetworkConnectionEntry> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedUdpTable, MIB_UDP6TABLE_OWNER_PID, UDP_TABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::AF_INET6;

    let mut entries = Vec::new();
    unsafe {
        let mut size: u32 = 0;
        let _ = GetExtendedUdpTable(
            None,
            &mut size,
            false,
            AF_INET6.0 as u32,
            UDP_TABLE_OWNER_PID,
            0,
        );
        if size == 0 {
            return entries;
        }
        let mut buffer = vec![0u8; size as usize];
        let ret = GetExtendedUdpTable(
            Some(buffer.as_mut_ptr() as *mut _),
            &mut size,
            false,
            AF_INET6.0 as u32,
            UDP_TABLE_OWNER_PID,
            0,
        );
        if ret != 0 {
            return entries;
        }

        let table = &*(buffer.as_ptr() as *const MIB_UDP6TABLE_OWNER_PID);
        let count = table.dwNumEntries as usize;
        let rows = std::slice::from_raw_parts(table.table.as_ptr(), count);

        for row in rows {
            let local_ip = Ipv6Addr::from(row.ucLocalAddr).to_string();
            let local_port = ntohs_u32(row.dwLocalPort);
            let pid = row.dwOwningPid;
            let (name, subtitle, category) = lookup_proc(proc_lookup, pid);

            entries.push(NetworkConnectionEntry {
                protocol: "UDPv6".to_string(),
                local_addr: local_ip,
                local_port,
                remote_addr: "*".to_string(),
                remote_port: 0,
                state: "LISTENING".to_string(),
                pid,
                process_name: name,
                process_subtitle: subtitle,
                category,
            });
        }
    }
    entries
}

#[cfg(windows)]
/// Lightweight per-PID connection counter for telemetry ticks.
/// Returns `HashMap<pid, (listening_count, established_count)>` without IP string formatting or sorting.
pub fn count_connections_per_pid() -> HashMap<u32, (u32, u32)> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6TABLE_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        MIB_UDP6TABLE_OWNER_PID, MIB_UDPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
        UDP_TABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    let mut counts: HashMap<u32, (u32, u32)> = HashMap::new();

    unsafe {
        // TCP v4
        let mut size: u32 = 0;
        let _ = GetExtendedTcpTable(
            None,
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if size > 0 {
            let mut buffer = vec![0u8; size as usize];
            if GetExtendedTcpTable(
                Some(buffer.as_mut_ptr() as *mut _),
                &mut size,
                false,
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            ) == 0
            {
                let table = &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(
                    table.table.as_ptr(),
                    table.dwNumEntries as usize,
                );
                for row in rows {
                    match row.dwState {
                        2 => counts.entry(row.dwOwningPid).or_insert((0, 0)).0 += 1,
                        5 => counts.entry(row.dwOwningPid).or_insert((0, 0)).1 += 1,
                        _ => {}
                    }
                }
            }
        }

        // TCP v6
        let mut size: u32 = 0;
        let _ = GetExtendedTcpTable(
            None,
            &mut size,
            false,
            AF_INET6.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if size > 0 {
            let mut buffer = vec![0u8; size as usize];
            if GetExtendedTcpTable(
                Some(buffer.as_mut_ptr() as *mut _),
                &mut size,
                false,
                AF_INET6.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            ) == 0
            {
                let table = &*(buffer.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(
                    table.table.as_ptr(),
                    table.dwNumEntries as usize,
                );
                for row in rows {
                    match row.dwState {
                        2 => counts.entry(row.dwOwningPid).or_insert((0, 0)).0 += 1,
                        5 => counts.entry(row.dwOwningPid).or_insert((0, 0)).1 += 1,
                        _ => {}
                    }
                }
            }
        }

        // UDP v4 (all entries counted as listening)
        let mut size: u32 = 0;
        let _ = GetExtendedUdpTable(
            None,
            &mut size,
            false,
            AF_INET.0 as u32,
            UDP_TABLE_OWNER_PID,
            0,
        );
        if size > 0 {
            let mut buffer = vec![0u8; size as usize];
            if GetExtendedUdpTable(
                Some(buffer.as_mut_ptr() as *mut _),
                &mut size,
                false,
                AF_INET.0 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            ) == 0
            {
                let table = &*(buffer.as_ptr() as *const MIB_UDPTABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(
                    table.table.as_ptr(),
                    table.dwNumEntries as usize,
                );
                for row in rows {
                    counts.entry(row.dwOwningPid).or_insert((0, 0)).0 += 1;
                }
            }
        }

        // UDP v6 (all entries counted as listening)
        let mut size: u32 = 0;
        let _ = GetExtendedUdpTable(
            None,
            &mut size,
            false,
            AF_INET6.0 as u32,
            UDP_TABLE_OWNER_PID,
            0,
        );
        if size > 0 {
            let mut buffer = vec![0u8; size as usize];
            if GetExtendedUdpTable(
                Some(buffer.as_mut_ptr() as *mut _),
                &mut size,
                false,
                AF_INET6.0 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            ) == 0
            {
                let table = &*(buffer.as_ptr() as *const MIB_UDP6TABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(
                    table.table.as_ptr(),
                    table.dwNumEntries as usize,
                );
                for row in rows {
                    counts.entry(row.dwOwningPid).or_insert((0, 0)).0 += 1;
                }
            }
        }
    }

    counts
}

#[cfg(not(windows))]
pub fn count_connections_per_pid() -> HashMap<u32, (u32, u32)> {
    HashMap::new()
}

#[cfg(not(windows))]
pub fn list_connections(
    _proc_lookup: &HashMap<u32, (String, String, String)>,
) -> Vec<NetworkConnectionEntry> {
    Vec::new()
}

// ============================================================================
// Close TCP Connection (SetTcpEntry -> MIB_TCP_STATE_DELETE_TCB)
// ============================================================================
#[cfg(windows)]
pub fn close_tcp_connection(
    local_addr: &str,
    local_port: u16,
    remote_addr: &str,
    remote_port: u16,
) -> Result<(), String> {
    use windows::Win32::NetworkManagement::IpHelper::{
        SetTcpEntry, MIB_TCPROW_LH, MIB_TCPROW_LH_0, MIB_TCP_STATE_DELETE_TCB,
    };

    let local_ip: Ipv4Addr = local_addr.parse().map_err(|_| {
        "IPv6-Verbindungen können von Windows (SetTcpEntry) nicht direkt getrennt werden."
            .to_string()
    })?;
    let remote_ip: Ipv4Addr = remote_addr.parse().map_err(|_| {
        "IPv6-Verbindungen können von Windows (SetTcpEntry) nicht direkt getrennt werden."
            .to_string()
    })?;

    let row = MIB_TCPROW_LH {
        Anonymous: MIB_TCPROW_LH_0 {
            State: MIB_TCP_STATE_DELETE_TCB,
        },
        dwLocalAddr: u32::from_ne_bytes(local_ip.octets()),
        dwLocalPort: u16::to_be(local_port) as u32,
        dwRemoteAddr: u32::from_ne_bytes(remote_ip.octets()),
        dwRemotePort: u16::to_be(remote_port) as u32,
    };

    let ret = unsafe { SetTcpEntry(&row) };
    match ret {
        0 => Ok(()),
        5 | 317 => Err(
            "Verbindung konnte nicht getrennt werden (Administratorrechte erforderlich).".into(),
        ),
        _ => Err(format!(
            "Verbindung konnte nicht getrennt werden (Fehlercode {ret}, evtl. bereits geschlossen oder Adminrechte nötig)."
        )),
    }
}

#[cfg(not(windows))]
pub fn close_tcp_connection(
    _local_addr: &str,
    _local_port: u16,
    _remote_addr: &str,
    _remote_port: u16,
) -> Result<(), String> {
    Err("Nur unter Windows unterstützt.".into())
}

// ============================================================================
// On-Demand Reverse-DNS with bounded in-memory TTL cache (max 256, 10 min)
// ============================================================================
#[cfg(windows)]
pub fn resolve_reverse_dns(ip: &str) -> Result<Option<String>, String> {
    use std::net::IpAddr;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows::Win32::Networking::WinSock::{
        getnameinfo, socklen_t, WSAStartup, AF_INET, AF_INET6, IN6_ADDR, IN6_ADDR_0, IN_ADDR,
        IN_ADDR_0, NI_NAMEREQD, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6, WSADATA,
    };

    const MAX_DNS_CACHE: usize = 256;
    const DNS_TTL: Duration = Duration::from_secs(600);

    static WSA_INIT: OnceLock<bool> = OnceLock::new();
    static DNS_CACHE: OnceLock<Mutex<HashMap<String, (Option<String>, Instant)>>> = OnceLock::new();

    let trimmed = ip.trim();
    let parsed: IpAddr = trimmed
        .parse()
        .map_err(|_| format!("Ungültige IP-Adresse: {trimmed}"))?;

    let cache = DNS_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let now = Instant::now();

    if let Ok(guard) = cache.lock() {
        if let Some((host, ts)) = guard.get(trimmed) {
            if now.duration_since(*ts) < DNS_TTL {
                return Ok(host.clone());
            }
        }
    }

    let wsa_ok = *WSA_INIT.get_or_init(|| unsafe {
        let mut data = WSADATA::default();
        WSAStartup(0x0202, &mut data) == 0
    });
    if !wsa_ok {
        return Err("WinSock konnte nicht initialisiert werden.".into());
    }

    let mut host_buf = [0u8; 1025];
    let rc = unsafe {
        match parsed {
            IpAddr::V4(v4) => {
                let sa = SOCKADDR_IN {
                    sin_family: AF_INET,
                    sin_port: 0,
                    sin_addr: IN_ADDR {
                        S_un: IN_ADDR_0 {
                            S_addr: u32::from_ne_bytes(v4.octets()),
                        },
                    },
                    sin_zero: [0; 8],
                };
                getnameinfo(
                    &sa as *const SOCKADDR_IN as *const SOCKADDR,
                    socklen_t(std::mem::size_of::<SOCKADDR_IN>() as i32),
                    Some(&mut host_buf),
                    None,
                    NI_NAMEREQD as i32,
                )
            }
            IpAddr::V6(v6) => {
                let mut sa = SOCKADDR_IN6::default();
                sa.sin6_family = AF_INET6;
                sa.sin6_addr = IN6_ADDR {
                    u: IN6_ADDR_0 {
                        Byte: v6.octets(),
                    },
                };
                getnameinfo(
                    &sa as *const SOCKADDR_IN6 as *const SOCKADDR,
                    socklen_t(std::mem::size_of::<SOCKADDR_IN6>() as i32),
                    Some(&mut host_buf),
                    None,
                    NI_NAMEREQD as i32,
                )
            }
        }
    };

    let resolved = if rc == 0 {
        let end = host_buf
            .iter()
            .position(|&b| b == 0)
            .unwrap_or(host_buf.len());
        let name = String::from_utf8_lossy(&host_buf[..end]).trim().to_string();
        if name.is_empty() || name == trimmed {
            None
        } else {
            Some(name)
        }
    } else {
        None
    };

    if let Ok(mut guard) = cache.lock() {
        if guard.len() >= MAX_DNS_CACHE && !guard.contains_key(trimmed) {
            guard.retain(|_, (_, ts)| now.duration_since(*ts) < DNS_TTL);
            if guard.len() >= MAX_DNS_CACHE {
                if let Some(oldest) = guard
                    .iter()
                    .min_by_key(|(_, (_, ts))| *ts)
                    .map(|(k, _)| k.clone())
                {
                    guard.remove(&oldest);
                }
            }
        }
        guard.insert(trimmed.to_string(), (resolved.clone(), now));
    }

    Ok(resolved)
}

#[cfg(not(windows))]
pub fn resolve_reverse_dns(_ip: &str) -> Result<Option<String>, String> {
    Ok(None)
}
