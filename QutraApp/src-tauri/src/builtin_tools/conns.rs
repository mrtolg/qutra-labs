//! Connection and PID monitor: the ports this machine listens on and its
//! open connections, each with the process that owns it. Read-only: it
//! reads the system's TCP and UDP tables (IP Helper) and the process list
//! (Tool Help); it opens no process and changes nothing.

use std::collections::HashMap;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// tcp or udp.
    pub protocol: String,
    /// 4 or 6.
    pub family: u8,
    pub local_address: String,
    pub local_port: u16,
    pub remote_address: String,
    pub remote_port: u16,
    /// listen, established, time_wait…; for UDP, "bound".
    pub state: String,
    pub pid: u32,
    /// The program's file name, or empty when the system does not say.
    pub process: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub connections: Vec<Connection>,
    pub taken_at: u64,
    /// False where the tables cannot be read (another OS).
    pub supported: bool,
}

/// The name MIB_TCP_STATE values go by.
pub fn tcp_state(state: u32) -> &'static str {
    match state {
        1 => "closed",
        2 => "listen",
        3 => "syn_sent",
        4 => "syn_received",
        5 => "established",
        6 => "fin_wait1",
        7 => "fin_wait2",
        8 => "close_wait",
        9 => "closing",
        10 => "last_ack",
        11 => "time_wait",
        12 => "delete_tcb",
        _ => "unknown",
    }
}

/// A port as the tables store it: network byte order in the low 16 bits.
pub fn port(raw: u32) -> u16 {
    u16::from_be(raw as u16)
}

/// Order rows the way a reader scans them: listening first, then by port.
pub fn sort(rows: &mut [Connection]) {
    rows.sort_by(|a, b| {
        let rank = |c: &Connection| match c.state.as_str() {
            "listen" => 0,
            "bound" => 1,
            "established" => 2,
            _ => 3,
        };
        rank(a)
            .cmp(&rank(b))
            .then(a.local_port.cmp(&b.local_port))
            .then(a.protocol.cmp(&b.protocol))
            .then(a.remote_address.cmp(&b.remote_address))
    });
}

/// Fill in each row's program from `names` (pid → file name).
pub fn name_processes(rows: &mut [Connection], names: &HashMap<u32, String>) {
    for row in rows {
        row.process = match row.pid {
            0 => "System Idle Process".into(),
            4 => "System".into(),
            pid => names.get(&pid).cloned().unwrap_or_default(),
        };
    }
}

#[cfg(windows)]
mod native {
    use std::{
        collections::HashMap,
        net::{Ipv4Addr, Ipv6Addr},
    };

    use windows::Win32::{
        Foundation::{CloseHandle, BOOL, ERROR_INSUFFICIENT_BUFFER, NO_ERROR},
        NetworkManagement::IpHelper::{
            GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
            MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
            UDP_TABLE_OWNER_PID,
        },
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };

    use super::{port, tcp_state, Connection};

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const MAX_ROWS: usize = 20_000;

    /// Call a GetExtended*Table function until its buffer is big enough;
    /// return the rows after the leading count.
    fn table<T: Copy>(read: impl Fn(*mut core::ffi::c_void, *mut u32) -> u32) -> Vec<T> {
        let mut size: u32 = 0;
        let mut buffer: Vec<u64> = Vec::new();
        for _ in 0..4 {
            let status = read(
                if buffer.is_empty() {
                    std::ptr::null_mut()
                } else {
                    buffer.as_mut_ptr().cast()
                },
                &mut size,
            );
            if status == NO_ERROR.0 && !buffer.is_empty() {
                // SAFETY: the table starts with a u32 count followed by that
                // many rows; the count is checked against the buffer's size.
                unsafe {
                    let base = buffer.as_ptr().cast::<u8>();
                    let count = (base as *const u32).read_unaligned() as usize;
                    let row_offset = std::mem::align_of::<T>().max(4);
                    let room =
                        (buffer.len() * 8).saturating_sub(row_offset) / std::mem::size_of::<T>();
                    let count = count.min(room).min(MAX_ROWS);
                    let rows = base.add(row_offset).cast::<T>();
                    return (0..count).map(|i| rows.add(i).read_unaligned()).collect();
                }
            }
            if status != ERROR_INSUFFICIENT_BUFFER.0 && !(status == NO_ERROR.0 && buffer.is_empty())
            {
                return Vec::new();
            }
            // Room for rows that appear between the two calls.
            buffer = vec![0u64; (size as usize + 4096) / 8 + 1];
            size = (buffer.len() * 8) as u32;
        }
        Vec::new()
    }

    pub fn connections() -> Vec<Connection> {
        let mut out = Vec::new();
        let tcp4: Vec<MIB_TCPROW_OWNER_PID> = table(|buf, size| unsafe {
            GetExtendedTcpTable(
                Some(buf),
                size,
                BOOL(0),
                AF_INET,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        });
        for row in tcp4 {
            let listening = row.dwState == 2;
            out.push(Connection {
                protocol: "tcp".into(),
                family: 4,
                local_address: Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).to_string(),
                local_port: port(row.dwLocalPort),
                remote_address: if listening {
                    String::new()
                } else {
                    Ipv4Addr::from(u32::from_be(row.dwRemoteAddr)).to_string()
                },
                remote_port: if listening { 0 } else { port(row.dwRemotePort) },
                state: tcp_state(row.dwState).into(),
                pid: row.dwOwningPid,
                process: String::new(),
            });
        }
        let tcp6: Vec<MIB_TCP6ROW_OWNER_PID> = table(|buf, size| unsafe {
            GetExtendedTcpTable(
                Some(buf),
                size,
                BOOL(0),
                AF_INET6,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        });
        for row in tcp6 {
            let listening = row.dwState == 2;
            out.push(Connection {
                protocol: "tcp".into(),
                family: 6,
                local_address: Ipv6Addr::from(row.ucLocalAddr).to_string(),
                local_port: port(row.dwLocalPort),
                remote_address: if listening {
                    String::new()
                } else {
                    Ipv6Addr::from(row.ucRemoteAddr).to_string()
                },
                remote_port: if listening { 0 } else { port(row.dwRemotePort) },
                state: tcp_state(row.dwState).into(),
                pid: row.dwOwningPid,
                process: String::new(),
            });
        }
        let udp4: Vec<MIB_UDPROW_OWNER_PID> = table(|buf, size| unsafe {
            GetExtendedUdpTable(Some(buf), size, BOOL(0), AF_INET, UDP_TABLE_OWNER_PID, 0)
        });
        for row in udp4 {
            out.push(Connection {
                protocol: "udp".into(),
                family: 4,
                local_address: Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).to_string(),
                local_port: port(row.dwLocalPort),
                remote_address: String::new(),
                remote_port: 0,
                state: "bound".into(),
                pid: row.dwOwningPid,
                process: String::new(),
            });
        }
        let udp6: Vec<MIB_UDP6ROW_OWNER_PID> = table(|buf, size| unsafe {
            GetExtendedUdpTable(Some(buf), size, BOOL(0), AF_INET6, UDP_TABLE_OWNER_PID, 0)
        });
        for row in udp6 {
            out.push(Connection {
                protocol: "udp".into(),
                family: 6,
                local_address: Ipv6Addr::from(row.ucLocalAddr).to_string(),
                local_port: port(row.dwLocalPort),
                remote_address: String::new(),
                remote_port: 0,
                state: "bound".into(),
                pid: row.dwOwningPid,
                process: String::new(),
            });
        }
        out
    }

    /// Every process's file name by its id, from one snapshot.
    pub fn process_names() -> HashMap<u32, String> {
        let mut names = HashMap::new();
        // SAFETY: the snapshot handle is closed below; each entry is read
        // into a zeroed struct whose dwSize says its layout.
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return names;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let end = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = crate::analysis::clean_text(&String::from_utf16_lossy(
                        &entry.szExeFile[..end],
                    ));
                    names.insert(entry.th32ProcessID, name);
                    if names.len() > 50_000 || Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        names
    }
}

/// Read the tables now.
pub fn snapshot(now_ms: u64) -> Snapshot {
    #[cfg(windows)]
    {
        let mut connections = native::connections();
        name_processes(&mut connections, &native::process_names());
        sort(&mut connections);
        Snapshot {
            connections,
            taken_at: now_ms,
            supported: true,
        }
    }
    #[cfg(not(windows))]
    {
        Snapshot {
            connections: Vec::new(),
            taken_at: now_ms,
            supported: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(protocol: &str, state: &str, port: u16, pid: u32) -> Connection {
        Connection {
            protocol: protocol.into(),
            family: 4,
            local_address: "0.0.0.0".into(),
            local_port: port,
            remote_address: String::new(),
            remote_port: 0,
            state: state.into(),
            pid,
            process: String::new(),
        }
    }

    #[test]
    fn ports_and_states_read_as_the_tables_store_them() {
        // Port 443 in network byte order, as dwLocalPort holds it.
        assert_eq!(port(u32::from(443u16.to_be())), 443);
        assert_eq!(port(0x0000_5000), 80);
        assert_eq!(tcp_state(2), "listen");
        assert_eq!(tcp_state(5), "established");
        assert_eq!(tcp_state(99), "unknown");
    }

    #[test]
    fn rows_are_named_and_ordered_for_reading() {
        let mut rows = vec![
            row("tcp", "established", 50000, 1234),
            row("udp", "bound", 53, 4),
            row("tcp", "listen", 8080, 1234),
            row("tcp", "listen", 135, 999),
        ];
        let names = HashMap::from([(1234, "node.exe".to_string())]);
        name_processes(&mut rows, &names);
        sort(&mut rows);
        let shown: Vec<(u16, &str, &str)> = rows
            .iter()
            .map(|r| (r.local_port, r.state.as_str(), r.process.as_str()))
            .collect();
        assert_eq!(
            shown,
            vec![
                (135, "listen", ""),
                (8080, "listen", "node.exe"),
                (53, "bound", "System"),
                (50000, "established", "node.exe"),
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn this_machine_s_tables_can_be_read() {
        // Read-only: lists what is there, opens nothing.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mine = listener.local_addr().unwrap().port();
        let snap = snapshot(1);
        assert!(snap.supported);
        let found = snap
            .connections
            .iter()
            .find(|c| c.protocol == "tcp" && c.local_port == mine && c.state == "listen")
            .expect("our own listening socket is in the table");
        assert_eq!(found.pid, std::process::id());
        assert!(!found.process.is_empty());
    }
}
