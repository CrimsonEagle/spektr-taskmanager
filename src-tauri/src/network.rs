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

#[cfg(not(windows))]
pub fn list_connections(
    _proc_lookup: &HashMap<u32, (String, String, String)>,
) -> Vec<NetworkConnectionEntry> {
    Vec::new()
}
