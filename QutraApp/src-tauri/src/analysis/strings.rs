//! Readable text inside the file (§6.2 "strings"): runs of at least four
//! printable characters, in ASCII and in UTF-16LE, and the web, IP and
//! e-mail addresses, Windows paths and registry keys among them.

use std::io;

use super::{
    scan::{each_chunk, Budget},
    Fact, Group, Report, Subject, MAX_ITEMS,
};

const MIN_LEN: usize = 4;
const MAX_LISTED: usize = 10_000;
/// A longer run is taken in pieces of this length, so all of a long line
/// (minified script, base64) is read and memory stays bounded.
const MAX_RUN: usize = 4096;
const MAX_SHOWN_CHARS: usize = 200;

#[derive(Default)]
struct Found {
    count: usize,
    items: Vec<String>,
}

impl Found {
    fn add(&mut self, item: &str) {
        self.count += 1;
        if self.items.len() < MAX_ITEMS && !self.items.iter().any(|known| known == item) {
            self.items.push(item.to_string());
        }
    }
}

#[derive(Default)]
struct Strings {
    ascii: usize,
    wide: usize,
    listed: Vec<(u64, char, String)>,
    urls: Found,
    ips: Found,
    emails: Found,
    paths: Found,
    registry: Found,
}

#[derive(Default)]
struct Scanner {
    ascii: Vec<u8>,
    ascii_at: u64,
    wide: Vec<u8>,
    wide_at: u64,
    /// The last byte was the first half of a UTF-16LE character.
    wide_half: bool,
}

fn printable(byte: u8) -> bool {
    byte == b'\t' || (0x20..=0x7E).contains(&byte)
}

impl Scanner {
    fn byte(&mut self, at: u64, byte: u8, out: &mut Strings) {
        if printable(byte) {
            if self.ascii.len() == MAX_RUN {
                self.flush_ascii(out);
            }
            if self.ascii.is_empty() {
                self.ascii_at = at;
            }
            self.ascii.push(byte);
        } else {
            self.flush_ascii(out);
        }
        if self.wide_half {
            if byte == 0 {
                self.wide_half = false;
                return;
            }
            self.flush_wide(out);
        }
        if printable(byte) {
            if self.wide.len() == MAX_RUN {
                self.flush_wide(out);
            }
            if self.wide.is_empty() {
                self.wide_at = at;
            }
            self.wide.push(byte);
            self.wide_half = true;
        } else {
            self.flush_wide(out);
        }
    }

    fn flush_ascii(&mut self, out: &mut Strings) {
        if self.ascii.len() >= MIN_LEN {
            out.take(self.ascii_at, false, &self.ascii);
        }
        self.ascii.clear();
    }

    fn flush_wide(&mut self, out: &mut Strings) {
        if self.wide.len() >= MIN_LEN {
            out.take(self.wide_at, true, &self.wide);
        }
        self.wide.clear();
        self.wide_half = false;
    }
}

impl Strings {
    fn take(&mut self, at: u64, wide: bool, bytes: &[u8]) {
        // Printable ASCII only, so always valid UTF-8.
        let text = String::from_utf8_lossy(bytes);
        if wide {
            self.wide += 1;
        } else {
            self.ascii += 1;
        }
        if self.listed.len() < MAX_LISTED {
            let shown: String = text.chars().take(MAX_SHOWN_CHARS).collect();
            self.listed.push((at, if wide { 'W' } else { 'A' }, shown));
        }
        self.classify(&text);
    }

    fn classify(&mut self, text: &str) {
        let tokens = text.split(|c: char| {
            c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '(' | ')' | ',' | ';' | '|')
        });
        for token in tokens.filter(|token| token.len() >= MIN_LEN) {
            let lower = token.to_ascii_lowercase();
            let url = ["http://", "https://", "ftp://"]
                .iter()
                .filter_map(|scheme| lower.find(scheme))
                .min();
            if let Some(at) = url {
                self.urls.add(&token[at..]);
            } else if is_ipv4(token) {
                self.ips.add(token);
            } else if is_email(token) {
                self.emails.add(token.trim_end_matches('.'));
            } else if lower.starts_with("hkey_")
                || lower.starts_with("hklm\\")
                || lower.starts_with("hkcu\\")
            {
                self.registry.add(token);
            } else if is_windows_path(token) {
                self.paths.add(token);
            }
        }
    }
}

/// A dotted quad, perhaps with a port. Versions are not: "1.0.0.0", and
/// four single digits without a port ("1.0.0.1", "2.1.0.0" in a program's
/// version resource), so a bare 8.8.8.8 is missed and 8.8.8.8:53 is not.
fn is_ipv4(token: &str) -> bool {
    let host = token.trim_end_matches(['.', ':']);
    let (host, port) = match host.split_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            (host, true)
        }
        Some(_) => return false,
        None => (host, false),
    };
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut octets = [0u16; 4];
    for (slot, part) in octets.iter_mut().zip(&parts) {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        *slot = part.parse().unwrap_or(256);
        if *slot > 255 {
            return false;
        }
    }
    octets[0] != 0 && octets[1..] != [0, 0, 0] && (port || octets.iter().any(|&o| o > 9))
}

/// Endings that make "icon@2x.png" a file name, not an address.
const FILE_ENDINGS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp", "js", "css", "json", "xml", "html",
    "htm", "txt", "log", "dat", "bin", "exe", "dll", "sys", "zip", "gz", "pdf", "doc", "docx",
    "xls", "xlsx", "ppt", "pptx", "mp3", "mp4", "wav", "avi", "mov", "ttf", "otf", "woff", "woff2",
];

fn is_email(token: &str) -> bool {
    let token = token.trim_end_matches('.');
    let Some((local, domain)) = token.split_once('@') else {
        return false;
    };
    let local_ok = !local.is_empty()
        && local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._%+-".contains(&b));
    let labels: Vec<&str> = domain.split('.').collect();
    let domain_ok = labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        && labels.last().is_some_and(|tld| {
            tld.len() >= 2
                && tld.bytes().all(|b| b.is_ascii_alphabetic())
                && !FILE_ENDINGS.contains(&tld.to_ascii_lowercase().as_str())
        });
    local_ok && domain_ok
}

fn is_windows_path(token: &str) -> bool {
    let bytes = token.as_bytes();
    (bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\')
        || (token.starts_with("\\\\") && token.len() > 3 && !token[2..].starts_with('\\'))
}

pub fn analyze(subject: &Subject, budget: &Budget) -> io::Result<Report> {
    let mut scanner = Scanner::default();
    let mut found = Strings::default();
    let scanned = each_chunk(subject.path, budget, |offset, chunk| {
        for (i, &byte) in chunk.iter().enumerate() {
            scanner.byte(offset + i as u64, byte, &mut found);
        }
    })?;
    scanner.flush_ascii(&mut found);
    scanner.flush_wide(&mut found);

    let mut facts = vec![
        Fact::new(Group::Summary, "strings.count", found.ascii + found.wide),
        Fact::new(Group::Detail, "strings.ascii", found.ascii),
        Fact::new(Group::Detail, "strings.utf16", found.wide),
    ];
    let categories: [(&'static str, &Found, Group); 5] = [
        ("strings.urls", &found.urls, Group::Interesting),
        ("strings.ips", &found.ips, Group::Interesting),
        ("strings.emails", &found.emails, Group::Interesting),
        ("strings.paths", &found.paths, Group::Detail),
        ("strings.registry", &found.registry, Group::Detail),
    ];
    let mut body = format!(
        "Strings of {MIN_LEN} or more printable characters in {} bytes\nASCII: {} · UTF-16LE: {}\n",
        scanned.read, found.ascii, found.wide
    );
    for (key, list, group) in categories {
        if list.count == 0 {
            continue;
        }
        facts.push(Fact::new(group, key, list.count).items(list.items.clone()));
        body.push_str(&format!("\n{key} ({}):\n", list.count));
        for item in &list.items {
            body.push_str(&format!("  {item}\n"));
        }
    }
    body.push_str(&format!(
        "\nThe first {} strings (offset, A = ASCII, W = UTF-16LE):\n",
        found.listed.len()
    ));
    for (at, encoding, text) in &found.listed {
        body.push_str(&format!("0x{at:08X} {encoding} {text}\n"));
    }
    Ok(Report {
        facts,
        body,
        limited: scanned.limited(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::testing::{budget, sample, subject};
    use super::*;

    fn fact<'a>(report: &'a Report, key: &str) -> Option<&'a Fact> {
        report.facts.iter().find(|fact| fact.key == key)
    }

    fn utf16(text: &str) -> Vec<u8> {
        text.bytes().flat_map(|b| [b, 0]).collect()
    }

    #[test]
    fn ascii_and_utf16_runs_of_four_are_found_shorter_ones_are_not() {
        let mut bytes = b"\x00\x01abc\x00\x02Merhaba\x00\xFF".to_vec();
        bytes.extend(utf16("Dosya"));
        bytes.extend_from_slice(b"\x01\x02");
        let file = sample(&bytes);
        let report = analyze(&subject(&file, "binary", None), &budget()).unwrap();
        assert_eq!(fact(&report, "strings.ascii").unwrap().value, 1);
        assert_eq!(fact(&report, "strings.utf16").unwrap().value, 1);
        assert_eq!(fact(&report, "strings.count").unwrap().value, 2);
        assert!(report.body.contains("0x00000007 A Merhaba"));
        assert!(report.body.contains("0x00000010 W Dosya"));
    }

    #[test]
    fn addresses_among_the_strings_stand_out() {
        let file = sample(
            b"\x00GET https://evil.example/payload.bin HTTP/1.1\x00connect 185.220.101.4:443\x00\
              mail ops@example.org.\x00HKEY_LOCAL_MACHINE\\Software\\Run\x00C:\\Users\\Public\\a.exe\x00",
        );
        let report = analyze(&subject(&file, "pe", None), &budget()).unwrap();
        let urls = fact(&report, "strings.urls").unwrap();
        assert_eq!(urls.group, Group::Interesting);
        assert_eq!(urls.items, vec!["https://evil.example/payload.bin"]);
        assert_eq!(
            fact(&report, "strings.ips").unwrap().items,
            vec!["185.220.101.4:443"]
        );
        assert_eq!(
            fact(&report, "strings.emails").unwrap().items,
            vec!["ops@example.org"]
        );
        assert_eq!(
            fact(&report, "strings.registry").unwrap().group,
            Group::Detail
        );
        assert_eq!(
            fact(&report, "strings.paths").unwrap().items,
            vec!["C:\\Users\\Public\\a.exe"]
        );
    }

    #[test]
    fn versions_are_not_addresses() {
        assert!(!is_ipv4("1.0.0.0"));
        assert!(!is_ipv4("10.0.19041.1"));
        assert!(!is_ipv4("0.1.2.3"));
        assert!(!is_ipv4("1.0.0.1"));
        assert!(!is_ipv4("2.1.0.0"));
        assert!(is_ipv4("8.8.8.8:53"));
        assert!(is_ipv4("10.0.0.1"));
        assert!(!is_email("a@b"));
        assert!(!is_email("icon@2x.png"));
        assert!(is_email("first.last@sub.example.com"));
    }

    #[test]
    fn a_long_line_is_read_to_its_end() {
        // One line of 10,000 characters, its address past the first 4,096.
        let mut bytes = vec![b'a'; 10_000];
        bytes.extend_from_slice(b" https://late.example/x\x00");
        let file = sample(&bytes);
        let report = analyze(&subject(&file, "text", None), &budget()).unwrap();
        assert_eq!(
            fact(&report, "strings.urls").unwrap().items,
            vec!["https://late.example/x"]
        );
    }
}
