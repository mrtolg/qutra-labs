//! Sample data: harmless files the user can analyse at
//! once. Every file is made here from fixed content, with nothing downloaded
//! and nothing run, so the same request makes the same bytes and adding them
//! a second time finds them already there. They go into an investigation by
//! the same path as a picked file (`investigation_files.rs`): copied into its
//! folder, hashed, typed, made read-only and listed.
//!
//! The renderer names samples by id from the fixed list below; Rust chooses
//! every file name and path.

use std::{
    fs,
    path::{Path, PathBuf},
};

use tauri::Manager;

use crate::engagement_folders::EngagementFolders;
use crate::investigation_files::{AddOutcome, InvestigationFiles, Source};

/// One sample the app can make.
pub struct Sample {
    pub id: &'static str,
    /// The name the file is added under.
    pub file_name: &'static str,
    build: fn() -> Vec<u8>,
}

impl Sample {
    pub fn bytes(&self) -> Vec<u8> {
        (self.build)()
    }
}

pub const SAMPLES: &[Sample] = &[
    Sample {
        id: "web-log",
        file_name: "ornek-web-erisim-gunlugu.log",
        build: web_log,
    },
    Sample {
        id: "pcap",
        file_name: "ornek-ag-trafigi.pcap",
        build: pcap,
    },
    Sample {
        id: "program",
        file_name: "ornek-zararsiz-program.exe",
        build: program,
    },
    Sample {
        id: "photo",
        file_name: "ornek-fotograf.jpg",
        build: photo,
    },
    Sample {
        id: "sarif",
        file_name: "ornek-kod-taramasi.sarif",
        build: sarif,
    },
    Sample {
        id: "event-log",
        file_name: "ornek-olay-gunlugu.csv",
        build: event_log,
    },
];

pub fn sample(id: &str) -> Option<&'static Sample> {
    SAMPLES.iter().find(|sample| sample.id == id)
}

/// The samples `ids` names, once each and in the list's order. Refuses an
/// empty request and any id the list does not have.
fn chosen(ids: &[String]) -> Result<Vec<&'static Sample>, String> {
    if ids.is_empty() {
        return Err("no_samples".into());
    }
    if let Some(unknown) = ids.iter().find(|id| sample(id).is_none()) {
        eprintln!("[Qutra Labs] unknown sample requested: {unknown:.40}");
        return Err("unknown_sample".into());
    }
    Ok(SAMPLES
        .iter()
        .filter(|sample| ids.iter().any(|id| id == sample.id))
        .collect())
}

/// Write the chosen samples under `staging`, add each to the investigation
/// whose folder is `folder`, then remove `staging`.
pub fn add_samples(
    files: &InvestigationFiles,
    staging: &Path,
    folder: &Path,
    engagement_id: &str,
    ids: &[String],
) -> Result<Vec<AddOutcome>, String> {
    let samples = chosen(ids)?;
    fs::create_dir_all(staging).map_err(|_| "sample_write_failed".to_string())?;
    let outcomes = samples
        .iter()
        .map(|sample| {
            let path = staging.join(sample.file_name);
            match fs::write(&path, sample.bytes()) {
                Ok(()) => files.add(folder, engagement_id, &path, Source::Sample),
                Err(_) => AddOutcome::Failed {
                    original_name: sample.file_name.to_string(),
                    reason: "sample_write_failed".into(),
                },
            }
        })
        .collect();
    if let Err(err) = fs::remove_dir_all(staging) {
        eprintln!("[Qutra Labs] sample staging not removed: {err}");
    }
    Ok(outcomes)
}

/// Make the chosen samples and add them to the investigation. Its folder
/// must exist (`no_engagement_folder` otherwise), as for a picked file.
#[tauri::command]
pub async fn sample_data_generate(
    app: tauri::AppHandle,
    folders: tauri::State<'_, EngagementFolders>,
    engagement_id: String,
    samples: Vec<String>,
) -> Result<Vec<AddOutcome>, String> {
    chosen(&samples)?;
    let folder = folders
        .folder_path(&engagement_id)?
        .ok_or_else(|| "no_engagement_folder".to_string())?;
    let staging: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|_| "sample_write_failed".to_string())?
        .join("lab")
        .join("sample-staging")
        .join(uuid::Uuid::new_v4().simple().to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let files = app.state::<InvestigationFiles>();
        add_samples(&files, &staging, &folder, &engagement_id, &samples)
    })
    .await
    .map_err(|_| "sample_write_failed".to_string())?
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/// 2026-10-01 00:00:00 UTC: the day every sample takes place.
const DAY: u64 = 1_790_812_800;

/// A small fixed-seed generator, so "random" spreads are the same each time.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

/// UTC calendar fields of a Unix time: (year, month, day, hour, minute, second).
fn civil(seconds: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        year,
        month,
        day,
        (rest / 3600) as u32,
        (rest % 3600 / 60) as u32,
        (rest % 60) as u32,
    )
}

/// `2026-10-01T09:00:00Z`
fn iso(seconds: u64) -> String {
    let (y, mo, d, h, mi, s) = civil(seconds);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/* ------------------------------------------------------------------ */
/* Web server access log                                               */
/* ------------------------------------------------------------------ */

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const BROWSERS: &[&str] = &[
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
];

/// Pages a visitor asks for, with the size each answer has.
const PAGES: &[(&str, &str, u32)] = &[
    ("GET", "/", 5123),
    ("GET", "/index.html", 5123),
    ("GET", "/urunler", 8410),
    ("GET", "/urunler/42", 6230),
    ("GET", "/urunler/17", 6018),
    ("GET", "/hakkimizda", 3954),
    ("GET", "/iletisim", 2871),
    ("GET", "/css/site.css", 14_220),
    ("GET", "/js/app.js", 41_877),
    ("GET", "/img/logo.png", 9_342),
    ("POST", "/api/sepet", 312),
];

struct LogLine {
    at: u64,
    text: String,
}

fn log_line(
    at: u64,
    ip: &str,
    request: &str,
    status: u16,
    bytes: u32,
    referer: &str,
    agent: &str,
) -> LogLine {
    let (y, mo, d, h, mi, s) = civil(at);
    let month = MONTHS[(mo - 1) as usize];
    LogLine {
        at,
        text: format!(
            "{ip} - - [{d:02}/{month}/{y}:{h:02}:{mi:02}:{s:02} +0000] \"{request} HTTP/1.1\" {status} {bytes} \"{referer}\" \"{agent}\""
        ),
    }
}

/// Three hours of a small shop's web server, in the combined log format:
/// ordinary visits, a search crawler, a few missing pages, one server error
/// and one visitor who mistypes a password several times. Addresses come
/// from the documentation ranges only.
fn web_log() -> Vec<u8> {
    let mut rng = Rng(0x5157_4C4F_4731);
    let start = DAY + 9 * 3600;
    let mut lines = Vec::new();

    let visitors: Vec<String> = (10..30)
        .map(|n| format!("198.51.100.{n}"))
        .chain((40..48).map(|n| format!("192.0.2.{n}")))
        .collect();
    let mut at = start;
    while at < start + 3 * 3600 {
        at += 20 + rng.below(70);
        let ip = rng.pick(&visitors).clone();
        let agent = *rng.pick(BROWSERS);
        let &(method, path, size) = rng.pick(PAGES);
        let referer = if path == "/" {
            "-"
        } else {
            "https://www.example.com/"
        };
        let (status, bytes) = match (method, rng.below(10)) {
            ("GET", 0) => (304, 0),
            _ => (200, size),
        };
        lines.push(log_line(
            at,
            &ip,
            &format!("{method} {path}"),
            status,
            bytes,
            referer,
            agent,
        ));
        if path == "/" && rng.below(3) == 0 {
            lines.push(log_line(
                at + 1,
                &ip,
                "GET /favicon.ico",
                404,
                196,
                referer,
                agent,
            ));
        }
    }

    // A crawler that reads robots.txt first.
    let bot = "ExampleBot/1.0 (+https://www.example.com/bot)";
    let crawl = start + 47 * 60;
    lines.push(log_line(
        crawl,
        "192.0.2.200",
        "GET /robots.txt",
        200,
        68,
        "-",
        bot,
    ));
    for (offset, path) in [
        "/",
        "/urunler",
        "/hakkimizda",
        "/iletisim",
        "/eski-kampanya",
    ]
    .iter()
    .enumerate()
    {
        let status = if *path == "/eski-kampanya" { 404 } else { 200 };
        let bytes = if status == 404 {
            196
        } else {
            4000 + offset as u32 * 731
        };
        lines.push(log_line(
            crawl + 4 + offset as u64 * 3,
            "192.0.2.200",
            &format!("GET {path}"),
            status,
            bytes,
            "-",
            bot,
        ));
    }

    // One visitor mistypes the password five times, then gets in.
    let login = start + 74 * 60;
    let member = "203.0.113.50";
    let agent = BROWSERS[0];
    lines.push(log_line(
        login,
        member,
        "GET /giris",
        200,
        2310,
        "https://www.example.com/",
        agent,
    ));
    for attempt in 0..5u64 {
        lines.push(log_line(
            login + 18 + attempt * 11,
            member,
            "POST /giris",
            401,
            412,
            "https://www.example.com/giris",
            agent,
        ));
    }
    lines.push(log_line(
        login + 90,
        member,
        "POST /giris",
        302,
        0,
        "https://www.example.com/giris",
        agent,
    ));
    lines.push(log_line(
        login + 91,
        member,
        "GET /hesabim",
        200,
        3877,
        "https://www.example.com/giris",
        agent,
    ));

    // One request the server could not answer.
    lines.push(log_line(
        start + 131 * 60 + 7,
        "198.51.100.23",
        "POST /api/sepet",
        500,
        0,
        "https://www.example.com/urunler/42",
        BROWSERS[1],
    ));

    lines.sort_by_key(|line| line.at);
    let mut out = String::new();
    for line in lines {
        out.push_str(&line.text);
        out.push('\n');
    }
    out.into_bytes()
}

/* ------------------------------------------------------------------ */
/* Packet capture                                                      */
/* ------------------------------------------------------------------ */

const CLIENT_MAC: [u8; 6] = [0x02, 0x00, 0x00, 0x00, 0x00, 0x17];
const GATEWAY_MAC: [u8; 6] = [0x02, 0x00, 0x00, 0x00, 0x00, 0x01];
const CLIENT_IP: [u8; 4] = [10, 0, 0, 23];
const RESOLVER_IP: [u8; 4] = [10, 0, 0, 53];
const GATEWAY_IP: [u8; 4] = [10, 0, 0, 1];
const SERVER_IP: [u8; 4] = [203, 0, 113, 80];

/// The ones' complement sum the IPv4, ICMP, TCP and UDP checksums use.
fn checksum(parts: &[&[u8]]) -> u16 {
    let mut sum: u32 = 0;
    for part in parts {
        let (pairs, rest) = part.as_chunks::<2>();
        for pair in pairs {
            sum += u32::from(u16::from_be_bytes(*pair));
        }
        if let [last] = rest {
            sum += u32::from(*last) << 8;
        }
    }
    while sum > 0xFFFF {
        sum = (sum & 0xFFFF) + (sum >> 16);
    }
    !(sum as u16)
}

struct Capture {
    out: Vec<u8>,
    ip_id: u16,
}

impl Capture {
    fn new() -> Self {
        let mut out = Vec::new();
        out.extend(0xA1B2_C3D4u32.to_le_bytes());
        out.extend(2u16.to_le_bytes());
        out.extend(4u16.to_le_bytes());
        out.extend(0i32.to_le_bytes());
        out.extend(0u32.to_le_bytes());
        out.extend(65_535u32.to_le_bytes());
        out.extend(1u32.to_le_bytes()); // Ethernet
        Self { out, ip_id: 0x1C40 }
    }

    /// One Ethernet frame holding an IPv4 packet with `payload`.
    fn ip(&mut self, at_ms: u64, src: [u8; 4], dst: [u8; 4], protocol: u8, payload: &[u8]) {
        let outbound = src == CLIENT_IP;
        let mut frame = Vec::new();
        frame.extend(if outbound { GATEWAY_MAC } else { CLIENT_MAC });
        frame.extend(if outbound { CLIENT_MAC } else { GATEWAY_MAC });
        frame.extend(0x0800u16.to_be_bytes());
        let mut header = [0u8; 20];
        header[0] = 0x45;
        header[2..4].copy_from_slice(&((20 + payload.len()) as u16).to_be_bytes());
        header[4..6].copy_from_slice(&self.ip_id.to_be_bytes());
        self.ip_id = self.ip_id.wrapping_add(1);
        header[6..8].copy_from_slice(&0x4000u16.to_be_bytes());
        header[8] = if outbound { 128 } else { 56 };
        header[9] = protocol;
        header[12..16].copy_from_slice(&src);
        header[16..20].copy_from_slice(&dst);
        let sum = checksum(&[&header]);
        header[10..12].copy_from_slice(&sum.to_be_bytes());
        frame.extend(header);
        frame.extend(payload);

        let at = DAY + 10 * 3600 + 5 * 60;
        let seconds = at + at_ms / 1000;
        self.out.extend((seconds as u32).to_le_bytes());
        self.out
            .extend((((at_ms % 1000) * 1000) as u32).to_le_bytes());
        self.out.extend((frame.len() as u32).to_le_bytes());
        self.out.extend((frame.len() as u32).to_le_bytes());
        self.out.extend(frame);
    }

    fn udp(&mut self, at_ms: u64, src: ([u8; 4], u16), dst: ([u8; 4], u16), data: &[u8]) {
        let length = (8 + data.len()) as u16;
        let mut segment = Vec::new();
        segment.extend(src.1.to_be_bytes());
        segment.extend(dst.1.to_be_bytes());
        segment.extend(length.to_be_bytes());
        segment.extend([0, 0]);
        segment.extend(data);
        let pseudo = pseudo_header(src.0, dst.0, 17, length);
        let sum = checksum(&[&pseudo, &segment]);
        segment[6..8].copy_from_slice(&sum.to_be_bytes());
        self.ip(at_ms, src.0, dst.0, 17, &segment);
    }

    #[allow(clippy::too_many_arguments)]
    fn tcp(
        &mut self,
        at_ms: u64,
        src: ([u8; 4], u16),
        dst: ([u8; 4], u16),
        seq: u32,
        ack: u32,
        flags: u8,
        data: &[u8],
    ) {
        let mut segment = Vec::new();
        segment.extend(src.1.to_be_bytes());
        segment.extend(dst.1.to_be_bytes());
        segment.extend(seq.to_be_bytes());
        segment.extend(ack.to_be_bytes());
        segment.push(5 << 4);
        segment.push(flags);
        segment.extend(64_240u16.to_be_bytes());
        segment.extend([0, 0, 0, 0]);
        segment.extend(data);
        let pseudo = pseudo_header(src.0, dst.0, 6, segment.len() as u16);
        let sum = checksum(&[&pseudo, &segment]);
        segment[16..18].copy_from_slice(&sum.to_be_bytes());
        self.ip(at_ms, src.0, dst.0, 6, &segment);
    }

    fn icmp_echo(&mut self, at_ms: u64, src: [u8; 4], dst: [u8; 4], reply: bool, sequence: u16) {
        let mut message = vec![if reply { 0 } else { 8 }, 0, 0, 0];
        message.extend(0x0001u16.to_be_bytes());
        message.extend(sequence.to_be_bytes());
        message.extend(b"abcdefghijklmnopqrstuvwabcdefghi");
        let sum = checksum(&[&message]);
        message[2..4].copy_from_slice(&sum.to_be_bytes());
        self.ip(at_ms, src, dst, 1, &message);
    }
}

fn pseudo_header(src: [u8; 4], dst: [u8; 4], protocol: u8, length: u16) -> Vec<u8> {
    let mut pseudo = Vec::with_capacity(12);
    pseudo.extend(src);
    pseudo.extend(dst);
    pseudo.push(0);
    pseudo.push(protocol);
    pseudo.extend(length.to_be_bytes());
    pseudo
}

fn dns_name(name: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for label in name.split('.') {
        out.push(label.len() as u8);
        out.extend(label.as_bytes());
    }
    out.push(0);
    out
}

fn dns_query(id: u16, name: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(id.to_be_bytes());
    out.extend(0x0100u16.to_be_bytes());
    out.extend([0, 1, 0, 0, 0, 0, 0, 0]);
    out.extend(dns_name(name));
    out.extend([0, 1, 0, 1]);
    out
}

fn dns_answer(id: u16, name: &str, address: [u8; 4]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(id.to_be_bytes());
    out.extend(0x8180u16.to_be_bytes());
    out.extend([0, 1, 0, 1, 0, 0, 0, 0]);
    out.extend(dns_name(name));
    out.extend([0, 1, 0, 1]);
    out.extend([0xC0, 0x0C, 0, 1, 0, 1]);
    out.extend(300u32.to_be_bytes());
    out.extend(4u16.to_be_bytes());
    out.extend(address);
    out
}

const SYN: u8 = 0x02;
const ACK: u8 = 0x10;
const PSH_ACK: u8 = 0x18;
const FIN_ACK: u8 = 0x11;
const SYN_ACK: u8 = 0x12;

/// A short, ordinary moment on a home network: a ping to the router, a DNS
/// lookup and one plain-HTTP page load from a documentation-range server.
fn pcap() -> Vec<u8> {
    let mut cap = Capture::new();
    cap.icmp_echo(0, CLIENT_IP, GATEWAY_IP, false, 1);
    cap.icmp_echo(2, GATEWAY_IP, CLIENT_IP, true, 1);

    let host = "www.example.com";
    cap.udp(
        1_000,
        (CLIENT_IP, 53_001),
        (RESOLVER_IP, 53),
        &dns_query(0x1A2B, host),
    );
    cap.udp(
        1_014,
        (RESOLVER_IP, 53),
        (CLIENT_IP, 53_001),
        &dns_answer(0x1A2B, host, SERVER_IP),
    );

    let client = (CLIENT_IP, 49_812);
    let server = (SERVER_IP, 80);
    let (c, s) = (0x6B1E_0000u32, 0x2F40_0000u32);
    cap.tcp(1_020, client, server, c, 0, SYN, &[]);
    cap.tcp(1_052, server, client, s, c + 1, SYN_ACK, &[]);
    cap.tcp(1_053, client, server, c + 1, s + 1, ACK, &[]);
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\nAccept: text/html\r\nConnection: close\r\n\r\n"
    );
    let request = request.as_bytes();
    cap.tcp(1_054, client, server, c + 1, s + 1, PSH_ACK, request);
    let body = "<!doctype html><html lang=\"tr\"><head><title>Ornek sayfa</title></head><body><h1>Merhaba</h1><p>Bu sayfa Qutra Labs ornek trafigi icindir.</p></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let response = response.as_bytes();
    let c_after = c + 1 + request.len() as u32;
    cap.tcp(1_088, server, client, s + 1, c_after, PSH_ACK, response);
    let s_after = s + 1 + response.len() as u32;
    cap.tcp(1_089, client, server, c_after, s_after, ACK, &[]);
    cap.tcp(1_090, server, client, s_after, c_after, FIN_ACK, &[]);
    cap.tcp(1_091, client, server, c_after, s_after + 1, FIN_ACK, &[]);
    cap.tcp(1_120, server, client, s_after + 1, c_after + 1, ACK, &[]);
    cap.out
}

/* ------------------------------------------------------------------ */
/* A program that does nothing                                         */
/* ------------------------------------------------------------------ */

fn put16(f: &mut [u8], at: usize, v: u16) {
    f[at..at + 2].copy_from_slice(&v.to_le_bytes());
}

fn put32(f: &mut [u8], at: usize, v: u32) {
    f[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

fn put64(f: &mut [u8], at: usize, v: u64) {
    f[at..at + 8].copy_from_slice(&v.to_le_bytes());
}

/// The PE checksum Windows' `CheckSumMappedFile` computes.
fn pe_checksum(file: &[u8], checksum_at: usize) -> u32 {
    let mut sum: u64 = 0;
    for (index, pair) in file.chunks(2).enumerate() {
        let at = index * 2;
        if at == checksum_at || at == checksum_at + 2 {
            continue;
        }
        let word = u64::from(pair[0]) | (u64::from(*pair.get(1).unwrap_or(&0)) << 8);
        sum += word;
        sum = (sum & 0xFFFF) + (sum >> 16);
    }
    sum = (sum & 0xFFFF) + (sum >> 16);
    (sum as u32) + file.len() as u32
}

/// A 64-bit Windows console program whose only instruction calls
/// `ExitProcess(0)`. Built here byte by byte: two sections, one import, a few
/// readable strings, no resources and no signature. It is added with the
/// `.sample` suffix like any program, and the app never runs it.
fn program() -> Vec<u8> {
    const TEXT_RVA: u32 = 0x1000;
    const RDATA_RVA: u32 = 0x2000;
    const IAT: u32 = RDATA_RVA;
    const DESCRIPTOR: u32 = RDATA_RVA + 0x10;
    const LOOKUP: u32 = RDATA_RVA + 0x40;
    const HINT_NAME: u32 = RDATA_RVA + 0x50;
    const DLL_NAME: u32 = RDATA_RVA + 0x60;
    const NOTES: u32 = RDATA_RVA + 0x70;
    let mut f = vec![0u8; 0x600];

    // DOS header and the message a DOS stub would print.
    f[..2].copy_from_slice(b"MZ");
    put16(&mut f, 0x02, 0x90);
    put16(&mut f, 0x04, 3);
    put16(&mut f, 0x08, 4);
    put16(&mut f, 0x0C, 0xFFFF);
    put16(&mut f, 0x10, 0xB8);
    put16(&mut f, 0x18, 0x40);
    put32(&mut f, 0x3C, 0x80);
    let stub = b"This program cannot be run in DOS mode.\r\r\n$";
    f[0x4E..0x4E + stub.len()].copy_from_slice(stub);

    // COFF header.
    f[0x80..0x84].copy_from_slice(b"PE\0\0");
    let coff = 0x84;
    put16(&mut f, coff, 0x8664);
    put16(&mut f, coff + 2, 2);
    put32(&mut f, coff + 4, 1_788_256_800); // 2026-09-01 10:00:00 UTC
    put16(&mut f, coff + 16, 240);
    put16(&mut f, coff + 18, 0x0022); // executable, large-address aware

    // Optional header (PE32+).
    let opt = coff + 20;
    put16(&mut f, opt, 0x20B);
    f[opt + 2] = 14;
    put32(&mut f, opt + 4, 0x200);
    put32(&mut f, opt + 8, 0x200);
    put32(&mut f, opt + 16, TEXT_RVA);
    put32(&mut f, opt + 20, TEXT_RVA);
    put64(&mut f, opt + 24, 0x1_4000_0000);
    put32(&mut f, opt + 32, 0x1000);
    put32(&mut f, opt + 36, 0x200);
    put16(&mut f, opt + 40, 6);
    put16(&mut f, opt + 48, 6);
    put32(&mut f, opt + 56, 0x3000);
    put32(&mut f, opt + 60, 0x200);
    put16(&mut f, opt + 68, 3); // console
    put16(&mut f, opt + 70, 0x8160); // high-entropy ASLR, ASLR, DEP, TS aware
    put64(&mut f, opt + 72, 0x10_0000);
    put64(&mut f, opt + 80, 0x1000);
    put64(&mut f, opt + 88, 0x10_0000);
    put64(&mut f, opt + 96, 0x1000);
    put32(&mut f, opt + 108, 16);
    let dirs = opt + 112;
    put32(&mut f, dirs + 8, DESCRIPTOR);
    put32(&mut f, dirs + 12, 40);
    put32(&mut f, dirs + 12 * 8, IAT);
    put32(&mut f, dirs + 12 * 8 + 4, 16);

    // Section table.
    let table = opt + 240;
    let section =
        |f: &mut [u8], at: usize, name: &[u8], vsize: u32, va: u32, raw: u32, flags: u32| {
            f[at..at + name.len()].copy_from_slice(name);
            put32(f, at + 8, vsize);
            put32(f, at + 12, va);
            put32(f, at + 16, 0x200);
            put32(f, at + 20, raw);
            put32(f, at + 36, flags);
        };
    section(&mut f, table, b".text", 0x10, TEXT_RVA, 0x200, 0x6000_0020);
    section(
        &mut f,
        table + 40,
        b".rdata",
        0x100,
        RDATA_RVA,
        0x400,
        0x4000_0040,
    );

    // .text: sub rsp, 28h; xor ecx, ecx; call [ExitProcess]; int3
    let code_at = 0x200;
    let call_end = TEXT_RVA + 4 + 2 + 6;
    let mut code = vec![0x48, 0x83, 0xEC, 0x28, 0x33, 0xC9, 0xFF, 0x15];
    code.extend((IAT.wrapping_sub(call_end)).to_le_bytes());
    code.push(0xCC);
    f[code_at..code_at + code.len()].copy_from_slice(&code);

    // .rdata: the import of KERNEL32.dll!ExitProcess and the notes.
    let raw = |rva: u32| (rva - RDATA_RVA) as usize + 0x400;
    put64(&mut f, raw(IAT), u64::from(HINT_NAME));
    put32(&mut f, raw(DESCRIPTOR), LOOKUP);
    put32(&mut f, raw(DESCRIPTOR) + 12, DLL_NAME);
    put32(&mut f, raw(DESCRIPTOR) + 16, IAT);
    put64(&mut f, raw(LOOKUP), u64::from(HINT_NAME));
    f[raw(HINT_NAME) + 2..raw(HINT_NAME) + 2 + 11].copy_from_slice(b"ExitProcess");
    f[raw(DLL_NAME)..raw(DLL_NAME) + 12].copy_from_slice(b"KERNEL32.dll");
    let notes = b"Qutra Labs ornek program: hicbir sey yapmaz, hemen kapanir.\0Surum 1.0 - egitim amacli ornek dosya\0";
    f[raw(NOTES)..raw(NOTES) + notes.len()].copy_from_slice(notes);

    let checksum_at = opt + 64;
    let sum = pe_checksum(&f, checksum_at);
    put32(&mut f, checksum_at, sum);
    f
}

/* ------------------------------------------------------------------ */
/* A photo with camera metadata                                        */
/* ------------------------------------------------------------------ */

/// Little-endian TIFF IFD builder: entries go in the IFD, values longer than
/// four bytes in a data area after it.
struct Ifd {
    entries: Vec<(u16, u16, u32, Vec<u8>)>,
}

impl Ifd {
    fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    fn ascii(mut self, tag: u16, text: &str) -> Self {
        let mut value = text.as_bytes().to_vec();
        value.push(0);
        let count = value.len() as u32;
        self.entries.push((tag, 2, count, value));
        self
    }

    fn short(mut self, tag: u16, value: u16) -> Self {
        self.entries.push((tag, 3, 1, value.to_le_bytes().to_vec()));
        self
    }

    fn long(mut self, tag: u16, value: u32) -> Self {
        self.entries.push((tag, 4, 1, value.to_le_bytes().to_vec()));
        self
    }

    fn bytes(mut self, tag: u16, value: &[u8]) -> Self {
        self.entries
            .push((tag, 1, value.len() as u32, value.to_vec()));
        self
    }

    fn rationals(mut self, tag: u16, values: &[(u32, u32)]) -> Self {
        let mut value = Vec::new();
        for (numerator, denominator) in values {
            value.extend(numerator.to_le_bytes());
            value.extend(denominator.to_le_bytes());
        }
        self.entries.push((tag, 5, values.len() as u32, value));
        self
    }

    fn len(&self) -> usize {
        let data: usize = self
            .entries
            .iter()
            .map(|(_, _, _, value)| {
                if value.len() > 4 {
                    value.len() + value.len() % 2
                } else {
                    0
                }
            })
            .sum();
        2 + self.entries.len() * 12 + 4 + data
    }

    /// The IFD as it sits at `offset` in the TIFF.
    fn write(mut self, offset: usize) -> Vec<u8> {
        self.entries.sort_by_key(|entry| entry.0);
        let mut out = Vec::new();
        out.extend((self.entries.len() as u16).to_le_bytes());
        let mut data = Vec::new();
        let data_at = offset + 2 + self.entries.len() * 12 + 4;
        for (tag, kind, count, value) in &self.entries {
            out.extend(tag.to_le_bytes());
            out.extend(kind.to_le_bytes());
            out.extend(count.to_le_bytes());
            if value.len() <= 4 {
                let mut inline = value.clone();
                inline.resize(4, 0);
                out.extend(inline);
            } else {
                out.extend(((data_at + data.len()) as u32).to_le_bytes());
                data.extend(value);
                if value.len() % 2 == 1 {
                    data.push(0);
                }
            }
        }
        out.extend(0u32.to_le_bytes());
        out.extend(data);
        out
    }
}

fn exif_tiff() -> Vec<u8> {
    let taken = "2026:09:28 14:32:10";
    let gps = Ifd::new()
        .bytes(0x0000, &[2, 3, 0, 0])
        .ascii(0x0001, "N")
        .rationals(0x0002, &[(41, 1), (1, 1), (3227, 100)])
        .ascii(0x0003, "E")
        .rationals(0x0004, &[(28, 1), (58, 1), (2703, 100)]);
    let exif = Ifd::new()
        .ascii(0x9003, taken)
        .ascii(0xA431, "OK200-000042")
        .long(0xA002, 64)
        .long(0xA003, 48);
    // IFD0's size does not depend on the pointer values, so measure it with
    // placeholders first.
    let ifd0 = |exif_at: u32, gps_at: u32| {
        Ifd::new()
            .ascii(0x010F, "Ornek Kamera")
            .ascii(0x0110, "Ornek Kamera OK-200")
            .short(0x0112, 1)
            .ascii(0x0131, "Qutra Labs ornek veri ureticisi")
            .ascii(0x0132, taken)
            .ascii(0x013B, "Ornek Fotografci")
            .long(0x8769, exif_at)
            .long(0x8825, gps_at)
    };
    let ifd0_len = ifd0(0, 0).len();
    let exif_at = 8 + ifd0_len;
    let gps_at = exif_at + exif.len();
    let mut tiff = b"II*\0".to_vec();
    tiff.extend(8u32.to_le_bytes());
    tiff.extend(ifd0(exif_at as u32, gps_at as u32).write(8));
    tiff.extend(exif.write(exif_at));
    tiff.extend(gps.write(gps_at));
    tiff
}

fn segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0xFF, marker];
    out.extend(((payload.len() + 2) as u16).to_be_bytes());
    out.extend(payload);
    out
}

/// Writes entropy-coded bits, stuffing a zero after every 0xFF byte.
struct BitWriter {
    out: Vec<u8>,
    current: u8,
    filled: u8,
}

impl BitWriter {
    fn put(&mut self, code: u32, length: u8) {
        for bit in (0..length).rev() {
            self.current = (self.current << 1) | ((code >> bit) & 1) as u8;
            self.filled += 1;
            if self.filled == 8 {
                self.flush_byte();
            }
        }
    }

    fn flush_byte(&mut self) {
        self.out.push(self.current);
        if self.current == 0xFF {
            self.out.push(0);
        }
        self.current = 0;
        self.filled = 0;
    }

    fn finish(mut self) -> Vec<u8> {
        while self.filled != 0 {
            self.put(1, 1);
        }
        self.out
    }
}

/// The standard luminance DC table (ITU T.81 K.3): code counts per length.
const DC_BITS: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];

/// Canonical Huffman codes for symbols 0.. in order: (code, length).
fn dc_codes() -> Vec<(u32, u8)> {
    let mut codes = Vec::new();
    let mut code = 0u32;
    for (index, &count) in DC_BITS.iter().enumerate() {
        for _ in 0..count {
            codes.push((code, index as u8 + 1));
            code += 1;
        }
        code <<= 1;
    }
    codes
}

/// A 64×48 grey picture of soft bands, as a baseline JPEG with every AC
/// coefficient zero, and an Exif block naming a camera, a date, a person and
/// a place (the Galata Tower in Istanbul, a public landmark). All of it is
/// made up for the sample.
fn photo() -> Vec<u8> {
    const WIDTH: u16 = 64;
    const HEIGHT: u16 = 48;
    let mut jpeg = vec![0xFF, 0xD8];
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend(exif_tiff());
    jpeg.extend(segment(0xE1, &app1));

    let mut dqt = vec![0x00];
    dqt.extend([8u8; 64]);
    jpeg.extend(segment(0xDB, &dqt));

    let mut sof = vec![8];
    sof.extend(HEIGHT.to_be_bytes());
    sof.extend(WIDTH.to_be_bytes());
    sof.extend([1, 1, 0x11, 0]);
    jpeg.extend(segment(0xC0, &sof));

    let mut dc = vec![0x00];
    dc.extend(DC_BITS);
    dc.extend(0u8..12);
    jpeg.extend(segment(0xC4, &dc));
    // AC table: end-of-block ("0") and zero run ("10"); only the first is used.
    let mut ac = vec![0x10, 1, 1];
    ac.extend([0u8; 14]);
    ac.extend([0x00, 0xF0]);
    jpeg.extend(segment(0xC4, &ac));

    jpeg.extend(segment(0xDA, &[1, 1, 0x00, 0, 63, 0]));
    let codes = dc_codes();
    let mut bits = BitWriter {
        out: Vec::new(),
        current: 0,
        filled: 0,
    };
    let mut previous = 0i32;
    for by in 0..i32::from(HEIGHT / 8) {
        for bx in 0..i32::from(WIDTH / 8) {
            // With every quantizer at 8, the DC value is the block's grey
            // level minus 128.
            let level = 70 + by * 22 + (bx % 4) * 6;
            let value = level - 128;
            let diff = value - previous;
            previous = value;
            let size = if diff == 0 {
                0
            } else {
                32 - diff.unsigned_abs().leading_zeros()
            };
            let (code, length) = codes[size as usize];
            bits.put(code, length);
            if size > 0 {
                let extra = if diff > 0 {
                    diff
                } else {
                    diff + (1 << size) - 1
                };
                bits.put(extra as u32, size as u8);
            }
            bits.put(0, 1); // end of block
        }
    }
    jpeg.extend(bits.finish());
    jpeg.extend([0xFF, 0xD9]);
    jpeg
}

/* ------------------------------------------------------------------ */
/* A code scan report                                                  */
/* ------------------------------------------------------------------ */

/// A SARIF 2.1.0 report from a made-up scan of a made-up Python shop app:
/// five code-quality and secure-coding findings, with no secrets in it.
fn sarif() -> Vec<u8> {
    let rule = |id: &str, name: &str, text: &str, level: &str, cwe: Option<&str>| {
        let mut tags = vec![serde_json::json!("security")];
        if let Some(cwe) = cwe {
            tags.push(serde_json::json!(format!("external/cwe/{cwe}")));
        }
        serde_json::json!({
            "id": id,
            "name": name,
            "shortDescription": { "text": text },
            "defaultConfiguration": { "level": level },
            "properties": { "tags": tags }
        })
    };
    let result = |id: &str, level: &str, text: &str, uri: &str, line: u32| {
        serde_json::json!({
            "ruleId": id,
            "level": level,
            "message": { "text": text },
            "locations": [{
                "physicalLocation": {
                    "artifactLocation": { "uri": uri },
                    "region": { "startLine": line }
                }
            }]
        })
    };
    let report = serde_json::json!({
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": "Qutra Labs ornek tarayici",
                    "version": "1.0.0",
                    "informationUri": "https://www.example.com/ornek-tarayici",
                    "rules": [
                        rule("py/sql-string", "SQL sorgusu metin birlestirmeyle kuruluyor", "Sorgu kullanıcı girdisiyle birleştirilerek kuruluyor.", "error", Some("cwe-89")),
                        rule("py/tls-verify-off", "Sertifika dogrulamasi kapali", "HTTPS isteğinde sertifika doğrulaması kapatılmış.", "error", Some("cwe-295")),
                        rule("py/weak-hash", "Zayif ozet algoritmasi", "Parola özetinde MD5 kullanılıyor.", "warning", Some("cwe-328")),
                        rule("py/debug-mode", "Hata ayiklama kipi acik", "Uygulama hata ayıklama kipinde başlatılıyor.", "warning", Some("cwe-489")),
                        rule("py/unused-import", "Kullanilmayan ice aktarma", "Dosyada kullanılmayan bir modül içe aktarılıyor.", "note", None),
                    ]
                }
            },
            "results": [
                result("py/sql-string", "error", "Sipariş sorgusu kullanıcı girdisi birleştirilerek kuruluyor; parametreli sorgu kullanın.", "app/siparisler.py", 41),
                result("py/tls-verify-off", "error", "Ödeme servisine yapılan istekte verify=False kullanılmış; sertifika doğrulamasını açın.", "app/odeme_istemcisi.py", 23),
                result("py/weak-hash", "warning", "Parolalar MD5 ile özetleniyor; bunun yerine bcrypt veya Argon2 kullanın.", "app/kimlik.py", 18),
                result("py/debug-mode", "warning", "Uygulama debug=True ile başlatılıyor; canlı ortamda kapatın.", "app/main.py", 57),
                result("py/unused-import", "note", "'os' modülü içe aktarılmış ama kullanılmıyor.", "app/main.py", 3),
            ]
        }]
    });
    let mut text = serde_json::to_string_pretty(&report).unwrap_or_default();
    text.push('\n');
    text.into_bytes()
}

/* ------------------------------------------------------------------ */
/* An event log timeline                                               */
/* ------------------------------------------------------------------ */

fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// One ordinary working day on an office computer, as a CSV export of
/// Windows events: start-up, sign-ins, a few mistyped passwords at the lock
/// screen, an update, a backup job reading a share, sign-out and shutdown.
fn event_log() -> Vec<u8> {
    let host = "WS-ORNEK-07";
    let rows: &[(u64, u32, &str, &str, &str, &str, &str)] = &[
        (8 * 3600 + 58 * 60 + 12, 6005, "Bilgi", "System", "EventLog", "-", "Olay günlüğü hizmeti başlatıldı."),
        (9 * 3600 + 60 + 40, 4624, "Bilgi", "Security", "Microsoft-Windows-Security-Auditing", "ORNEK\\ayse", "Bir hesap başarıyla oturum açtı. Oturum türü: 2 (etkileşimli)."),
        (9 * 3600 + 3 * 60 + 5, 4688, "Bilgi", "Security", "Microsoft-Windows-Security-Auditing", "ORNEK\\ayse", "Yeni işlem oluşturuldu: C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE"),
        (11 * 3600 + 15 * 60 + 22, 4625, "Denetim hatası", "Security", "Microsoft-Windows-Security-Auditing", "ORNEK\\ayse", "Bir hesap oturum açamadı. Oturum türü: 7 (kilit açma). Neden: hatalı kullanıcı adı veya parola."),
        (11 * 3600 + 15 * 60 + 31, 4625, "Denetim hatası", "Security", "Microsoft-Windows-Security-Auditing", "ORNEK\\ayse", "Bir hesap oturum açamadı. Oturum türü: 7 (kilit açma). Neden: hatalı kullanıcı adı veya parola."),
        (11 * 3600 + 15 * 60 + 40, 4625, "Denetim hatası", "Security", "Microsoft-Windows-Security-Auditing", "ORNEK\\ayse", "Bir hesap oturum açamadı. Oturum türü: 7 (kilit açma). Neden: hatalı kullanıcı adı veya parola."),
        (11 * 3600 + 15 * 60 + 52, 4624, "Bilgi", "Security", "Microsoft-Windows-Security-Auditing", "ORNEK\\ayse", "Bir hesap başarıyla oturum açtı. Oturum türü: 7 (kilit açma)."),
        (12 * 3600 + 30 * 60, 19, "Bilgi", "System", "Microsoft-Windows-WindowsUpdateClient", "NT AUTHORITY\\SYSTEM", "Güncelleştirme başarıyla yüklendi: 2026-09 toplu güncelleştirme (örnek)."),
        (13 * 3600 + 5 * 60 + 18, 4624, "Bilgi", "Security", "Microsoft-Windows-Security-Auditing", "ORNEK\\yedekleme", "Bir hesap başarıyla oturum açtı. Oturum türü: 3 (ağ). Kaynak adres: 10.0.0.5."),
        (13 * 3600 + 5 * 60 + 19, 5140, "Bilgi", "Security", "Microsoft-Windows-Security-Auditing", "ORNEK\\yedekleme", "Bir ağ paylaşımına erişildi: \\\\*\\Paylasim. Kaynak adres: 10.0.0.5."),
        (13 * 3600 + 41 * 60 + 2, 4634, "Bilgi", "Security", "Microsoft-Windows-Security-Auditing", "ORNEK\\yedekleme", "Bir hesabın oturumu kapatıldı. Oturum türü: 3 (ağ)."),
        (17 * 3600 + 32 * 60 + 9, 4647, "Bilgi", "Security", "Microsoft-Windows-Security-Auditing", "ORNEK\\ayse", "Kullanıcı oturumu kapatmayı başlattı."),
        (17 * 3600 + 33 * 60, 1074, "Bilgi", "System", "User32", "ORNEK\\ayse", "Bilgisayar kullanıcı isteğiyle kapatılıyor."),
    ];
    let mut out =
        String::from("TimeCreated,EventId,Level,Channel,Provider,Computer,User,Message\n");
    for (offset, id, level, channel, provider, user, message) in rows {
        let fields = [
            iso(DAY + offset),
            id.to_string(),
            (*level).to_string(),
            (*channel).to_string(),
            (*provider).to_string(),
            host.to_string(),
            (*user).to_string(),
            (*message).to_string(),
        ];
        let line: Vec<String> = fields.iter().map(|field| csv_field(field)).collect();
        out.push_str(&line.join(","));
        out.push('\n');
    }
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::testing::{budget, sample as staged, subject};
    use crate::investigation_files::detect_kind;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn every_sample_is_the_same_each_time_and_has_the_kind_its_name_says() {
        let expected = [
            ("web-log", "text"),
            ("pcap", "pcap"),
            ("program", "pe"),
            ("photo", "jpeg"),
            ("sarif", "text"),
            ("event-log", "text"),
        ];
        assert_eq!(SAMPLES.len(), expected.len());
        for (id, kind) in expected {
            let sample = sample(id).unwrap();
            let bytes = sample.bytes();
            assert!(!bytes.is_empty(), "{id}");
            assert_eq!(bytes, sample.bytes(), "{id} is not deterministic");
            let extension = Path::new(sample.file_name)
                .extension()
                .and_then(|e| e.to_str());
            assert_eq!(
                detect_kind(&bytes[..bytes.len().min(4096)], extension),
                kind,
                "{id}"
            );
        }
    }

    #[test]
    fn the_day_is_the_first_of_october_2026() {
        assert_eq!(iso(DAY), "2026-10-01T00:00:00Z");
        assert_eq!(iso(DAY + 9 * 3600 + 61), "2026-10-01T09:01:01Z");
        assert_eq!(iso(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn the_web_log_is_ordered_and_uses_documentation_addresses_only() {
        let text = String::from_utf8(sample("web-log").unwrap().bytes()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines.len() > 100, "{}", lines.len());
        for line in &lines {
            let ip = line.split(' ').next().unwrap();
            assert!(
                ip.starts_with("198.51.100.")
                    || ip.starts_with("192.0.2.")
                    || ip.starts_with("203.0.113."),
                "{ip}"
            );
        }
        assert_eq!(text.matches("\"POST /giris HTTP/1.1\" 401").count(), 5);
        assert_eq!(text.matches("\" 500 ").count(), 1);
        let stamps: Vec<&str> = lines
            .iter()
            .map(|line| line.split('[').nth(1).unwrap().split(']').next().unwrap())
            .collect();
        let mut sorted = stamps.clone();
        sorted.sort();
        assert_eq!(stamps, sorted);
    }

    #[test]
    fn every_packet_in_the_capture_is_whole_and_its_checksums_hold() {
        let bytes = sample("pcap").unwrap().bytes();
        assert_eq!(&bytes[..4], &[0xD4, 0xC3, 0xB2, 0xA1]);
        let mut at = 24;
        let mut packets = 0;
        while at < bytes.len() {
            let length = u32::from_le_bytes(bytes[at + 8..at + 12].try_into().unwrap()) as usize;
            let frame = &bytes[at + 16..at + 16 + length];
            assert_eq!(&frame[12..14], &[0x08, 0x00]);
            let ip = &frame[14..];
            assert_eq!(checksum(&[&ip[..20]]), 0, "IPv4 header of packet {packets}");
            let total = u16::from_be_bytes([ip[2], ip[3]]) as usize;
            assert_eq!(total, ip.len());
            let payload = &ip[20..];
            let src: [u8; 4] = ip[12..16].try_into().unwrap();
            let dst: [u8; 4] = ip[16..20].try_into().unwrap();
            match ip[9] {
                1 => assert_eq!(checksum(&[payload]), 0, "ICMP of packet {packets}"),
                protocol @ (6 | 17) => {
                    let pseudo = pseudo_header(src, dst, protocol, payload.len() as u16);
                    assert_eq!(checksum(&[&pseudo, payload]), 0, "packet {packets}");
                }
                other => panic!("unexpected protocol {other}"),
            }
            at += 16 + length;
            packets += 1;
        }
        assert_eq!(at, bytes.len());
        assert_eq!(packets, 13);
    }

    #[test]
    fn the_program_reads_as_a_plain_console_program_with_one_import() {
        let file = staged(&sample("program").unwrap().bytes());
        let report =
            crate::analysis::pe::analyze(&subject(&file, "pe", Some("exe")), &budget()).unwrap();
        let keys: Vec<&str> = report.facts.iter().map(|fact| fact.key).collect();
        assert!(!keys.contains(&"pe.invalid"), "{keys:?}");
        let imports = report
            .facts
            .iter()
            .find(|fact| fact.key == "pe.imports")
            .unwrap();
        assert_eq!(imports.value, 1);
        for alarm in [
            "pe.writableCode",
            "pe.entryOutside",
            "pe.riskyImports",
            "pe.noImports",
            "pe.oddDate",
            "pe.packedSections",
            "pe.overlay",
        ] {
            assert!(!keys.contains(&alarm), "{alarm}");
        }
        assert!(report.body.contains("KERNEL32.dll"), "{}", report.body);
    }

    #[test]
    fn the_photo_carries_its_camera_date_and_place() {
        let file = staged(&sample("photo").unwrap().bytes());
        let report =
            crate::analysis::image::analyze(&subject(&file, "jpeg", Some("jpg")), &budget())
                .unwrap();
        let value = |key: &str| {
            report
                .facts
                .iter()
                .find(|fact| fact.key == key)
                .map(|fact| fact.value.clone())
                .unwrap_or_else(|| {
                    panic!(
                        "{key} missing: {:?}",
                        report.facts.iter().map(|f| f.key).collect::<Vec<_>>()
                    )
                })
        };
        assert_eq!(value("image.camera"), "Ornek Kamera OK-200");
        assert_eq!(value("image.taken"), "2026:09:28 14:32:10");
        assert_eq!(value("image.gps"), "41.025631, 28.974175");
        assert_eq!(value("image.owner"), "Ornek Fotografci");
        assert_eq!(value("image.serial"), "OK200-000042");
        let bytes = sample("photo").unwrap().bytes();
        assert!(bytes.ends_with(&[0xFF, 0xD9]));
    }

    #[test]
    fn the_sarif_report_is_valid_json_with_five_results() {
        let bytes = sample("sarif").unwrap().bytes();
        let report: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(report["version"], "2.1.0");
        assert_eq!(report["runs"][0]["results"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn the_event_log_has_a_header_and_one_row_per_event() {
        let text = String::from_utf8(sample("event-log").unwrap().bytes()).unwrap();
        let mut lines = text.lines();
        assert_eq!(
            lines.next(),
            Some("TimeCreated,EventId,Level,Channel,Provider,Computer,User,Message")
        );
        let rows: Vec<&str> = lines.collect();
        assert_eq!(rows.len(), 13);
        assert!(rows.iter().all(|row| row.starts_with("2026-10-01T")));
        assert_eq!(rows.iter().filter(|row| row.contains(",4625,")).count(), 3);
    }

    #[test]
    fn a_request_names_known_samples_only() {
        assert_eq!(chosen(&[]).err().as_deref(), Some("no_samples"));
        assert_eq!(
            chosen(&ids(&["photo", "../x"])).err().as_deref(),
            Some("unknown_sample")
        );
        let picked: Vec<&str> = chosen(&ids(&["sarif", "pcap", "pcap"]))
            .unwrap()
            .iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(picked, vec!["pcap", "sarif"]);
    }

    #[test]
    fn samples_are_added_like_picked_files_and_found_again_the_second_time() {
        let app_data = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let staging = app_data.path().join("staging");
        let files = InvestigationFiles::load(app_data.path());
        let all: Vec<String> = SAMPLES.iter().map(|s| s.id.to_string()).collect();

        let first = add_samples(&files, &staging, folder.path(), "eng_sample", &all).unwrap();
        assert_eq!(first.len(), SAMPLES.len());
        let mut names = Vec::new();
        for outcome in &first {
            match outcome {
                AddOutcome::Added { file } => {
                    assert_eq!(file.file.source, "sample");
                    assert!(!file.missing);
                    names.push(file.file.name.clone());
                }
                other => panic!("not added: {other:?}"),
            }
        }
        assert!(
            names.contains(&"ornek-zararsiz-program.exe.sample".to_string()),
            "{names:?}"
        );
        assert!(!staging.exists(), "staging was left behind");

        let second = add_samples(&files, &staging, folder.path(), "eng_sample", &all).unwrap();
        assert!(
            second
                .iter()
                .all(|o| matches!(o, AddOutcome::Duplicate { .. })),
            "{second:?}"
        );
        assert_eq!(
            files.list("eng_sample", Some(folder.path())).unwrap().len(),
            SAMPLES.len()
        );
    }
}
