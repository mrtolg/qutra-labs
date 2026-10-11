//! Metadata inspector: what a file says about itself, for a file the user
//! picks. A photo's Exif and GPS and a program's header come from the
//! built-in analyzers (`analysis::image`, `analysis::pe`); this
//! module adds XMP packets, a PDF's document information and risky keys,
//! and an Office or OpenDocument file's properties and macros.
//!
//! The file is read, never opened or run, within `CAP` bytes; a location is
//! shown as text and never looked up.

use std::{
    fs::File,
    io::{self, Read},
    path::Path,
    sync::OnceLock,
    time::Duration,
};

use regex::bytes::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{clean, clean_long};
use crate::analysis::{self, scan::Budget, Observation, Subject};

const CAP: u64 = 64 * 1024 * 1024;
const TIME: Duration = Duration::from_secs(30);
const MAX_FIELDS: usize = 80;
const MAX_TAGS: usize = 200;
/// The most an Office part may inflate to.
const MAX_PART: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocField {
    /// pdf, office, odf or xmp.
    pub source: String,
    /// The field's own name: `Author`, `dc:creator`, `Application`…
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
    /// javascript, openAction, launch, embeddedFile, macros…
    pub key: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gps {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataReport {
    /// The file's name, never its folder.
    pub name: String,
    pub bytes: u64,
    pub modified_ms: Option<u64>,
    pub kind: String,
    pub sha256: String,
    /// What the built-in analyzers found (identify, image, pe), labelled by
    /// the page like an analysis's observations.
    pub observations: Vec<Observation>,
    /// Every Exif or PNG tag read, as text.
    pub tags: Vec<String>,
    pub fields: Vec<DocField>,
    pub flags: Vec<Flag>,
    pub gps: Option<Gps>,
    /// A size or time limit stopped a reader before the end.
    pub limited: bool,
}

fn extension_of(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    let plain = !stem.is_empty()
        && !ext.is_empty()
        && ext.len() <= 16
        && ext.bytes().all(|b| b.is_ascii_alphanumeric());
    plain.then(|| ext.to_ascii_lowercase())
}

/* ---------------- XMP ---------------- */

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a fixed pattern"))
}

fn unescape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(end) = tail.find(';').filter(|&end| end <= 10) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

const SKIPPED_PREFIXES: &[&str] = &["xmlns", "rdf", "x", "xml", "stRef"];

fn push_field(fields: &mut Vec<DocField>, source: &str, key: &str, value: &str) {
    let value = clean_long(&unescape_xml(value), 300);
    let key = clean(key);
    if value.is_empty()
        || key.is_empty()
        || fields.len() >= MAX_FIELDS
        || fields
            .iter()
            .any(|f| f.source == source && f.key == key && f.value == value)
    {
        return;
    }
    fields.push(DocField {
        source: source.into(),
        key,
        value,
    });
}

/// The `prefix:Name` properties of XML properties text (an XMP packet, an
/// Office core.xml): attributes, simple elements, and rdf lists joined.
fn xml_properties(xml: &[u8], source: &str, fields: &mut Vec<DocField>) {
    static ATTR: OnceLock<Regex> = OnceLock::new();
    static ELEMENT: OnceLock<Regex> = OnceLock::new();
    static LIST: OnceLock<Regex> = OnceLock::new();
    static ITEM: OnceLock<Regex> = OnceLock::new();
    let attr = regex(
        &ATTR,
        r#"\s([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)="([^"<]{1,500})""#,
    );
    let element = regex(
        &ELEMENT,
        r"<([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)(?:\s[^>]*)?>([^<]{1,500})</([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)>",
    );
    let list = regex(
        &LIST,
        r"(?s)<([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)(?:\s[^>]*)?>\s*<rdf:(?:Seq|Bag|Alt)>(.{0,4000}?)</rdf:(?:Seq|Bag|Alt)>",
    );
    let item = regex(&ITEM, r"<rdf:li(?:\s[^>]*)?>([^<]{1,500})</rdf:li>");
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    for caps in list.captures_iter(xml) {
        let prefix = text(&caps[1]);
        if SKIPPED_PREFIXES.contains(&prefix.as_str()) {
            continue;
        }
        let values: Vec<String> = item
            .captures_iter(&caps[3])
            .map(|c| text(&c[1]).trim().to_string())
            .filter(|v| !v.is_empty())
            .take(10)
            .collect();
        if !values.is_empty() {
            push_field(
                fields,
                source,
                &format!("{prefix}:{}", text(&caps[2])),
                &values.join(", "),
            );
        }
    }
    for caps in element.captures_iter(xml) {
        if caps[1] != caps[4] || caps[2] != caps[5] {
            continue;
        }
        let prefix = text(&caps[1]);
        if SKIPPED_PREFIXES.contains(&prefix.as_str()) {
            continue;
        }
        push_field(
            fields,
            source,
            &format!("{prefix}:{}", text(&caps[2])),
            text(&caps[3]).trim(),
        );
    }
    for caps in attr.captures_iter(xml) {
        let prefix = text(&caps[1]);
        if SKIPPED_PREFIXES.contains(&prefix.as_str()) {
            continue;
        }
        push_field(
            fields,
            source,
            &format!("{prefix}:{}", text(&caps[2])),
            &text(&caps[3]),
        );
    }
}

fn find(data: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    data.get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

/// Every XMP packet in the file, at most four.
fn xmp(data: &[u8], fields: &mut Vec<DocField>, budget: &Budget) {
    let mut from = 0;
    for _ in 0..4 {
        if budget.expired() {
            return;
        }
        let Some(start) = find(data, b"<x:xmpmeta", from) else {
            return;
        };
        let end = find(data, b"</x:xmpmeta>", start)
            .map(|end| end + 12)
            .unwrap_or(data.len().min(start + 512 * 1024));
        let packet = &data[start..end.min(start + 2 * 1024 * 1024)];
        xml_properties(packet, "xmp", fields);
        from = end;
    }
}

/* ---------------- PDF ---------------- */

/// A PDF string, literal `( … )` or hex `< … >`, as text (UTF-16 when it
/// starts with a byte order mark, else PDFDocEncoding read as Latin-1).
fn pdf_string(data: &[u8]) -> Option<String> {
    let mut bytes = Vec::new();
    match data.first()? {
        b'(' => {
            let mut depth = 0usize;
            let mut i = 1;
            while i < data.len() && bytes.len() < 4096 {
                let b = data[i];
                match b {
                    b'\\' => {
                        let next = *data.get(i + 1)?;
                        i += 1;
                        match next {
                            b'n' => bytes.push(b'\n'),
                            b'r' => bytes.push(b'\r'),
                            b't' => bytes.push(b'\t'),
                            b'b' => bytes.push(8),
                            b'f' => bytes.push(12),
                            b'0'..=b'7' => {
                                let mut value = 0u32;
                                let mut n = 0;
                                while n < 3
                                    && data.get(i + n).is_some_and(|c| (b'0'..=b'7').contains(c))
                                {
                                    value = value * 8 + (data[i + n] - b'0') as u32;
                                    n += 1;
                                }
                                bytes.push(value as u8);
                                i += n - 1;
                            }
                            b'\r' | b'\n' => {}
                            other => bytes.push(other),
                        }
                    }
                    b'(' => {
                        depth += 1;
                        bytes.push(b);
                    }
                    b')' => {
                        if depth == 0 {
                            break;
                        }
                        depth -= 1;
                        bytes.push(b);
                    }
                    _ => bytes.push(b),
                }
                i += 1;
            }
        }
        b'<' => {
            let end = data.iter().position(|&b| b == b'>')?;
            let hex: Vec<u8> = data[1..end]
                .iter()
                .copied()
                .filter(|b| b.is_ascii_hexdigit())
                .collect();
            for pair in hex.chunks(2).take(4096) {
                let text = std::str::from_utf8(pair).ok()?;
                let padded = if text.len() == 1 {
                    format!("{text}0")
                } else {
                    text.to_string()
                };
                bytes.push(u8::from_str_radix(&padded, 16).ok()?);
            }
        }
        _ => return None,
    }
    let text = if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_be_bytes(*pair))
            .collect();
        String::from_utf16_lossy(&units)
    } else if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else {
        bytes.iter().map(|&b| b as char).collect()
    };
    Some(text)
}

/// `D:20230102030405+03'00'` as `2023-01-02 03:04:05 +03:00`.
pub fn pdf_date(raw: &str) -> String {
    let digits = raw.trim().trim_start_matches("D:");
    let part = |a: usize, b: usize| {
        digits
            .get(a..b)
            .filter(|s| s.bytes().all(|c| c.is_ascii_digit()))
    };
    let (Some(y), Some(m), Some(d)) = (part(0, 4), part(4, 6), part(6, 8)) else {
        return raw.to_string();
    };
    let time = match (part(8, 10), part(10, 12), part(12, 14)) {
        (Some(h), Some(min), Some(s)) => format!(" {h}:{min}:{s}"),
        (Some(h), Some(min), None) => format!(" {h}:{min}"),
        _ => String::new(),
    };
    let zone = match digits.get(14..) {
        Some(z) if z.starts_with('Z') => " UTC".to_string(),
        Some(z) if z.starts_with('+') || z.starts_with('-') => {
            let clean: String = z.chars().filter(|c| c.is_ascii_digit()).collect();
            match (clean.get(0..2), clean.get(2..4)) {
                (Some(h), Some(m)) => format!(" {}{h}:{m}", &z[..1]),
                (Some(h), None) => format!(" {}{h}:00", &z[..1]),
                _ => String::new(),
            }
        }
        _ => String::new(),
    };
    format!("{y}-{m}-{d}{time}{zone}")
}

const PDF_KEYS: &[&str] = &[
    "Title",
    "Author",
    "Subject",
    "Keywords",
    "Creator",
    "Producer",
    "CreationDate",
    "ModDate",
    "Trapped",
];

/// Names whose presence in a PDF is worth a look (as pdfid counts them).
const PDF_RISKY: &[(&str, &[u8])] = &[
    ("javascript", b"/JavaScript"),
    ("js", b"/JS"),
    ("openAction", b"/OpenAction"),
    ("autoAction", b"/AA"),
    ("launch", b"/Launch"),
    ("embeddedFile", b"/EmbeddedFile"),
    ("uri", b"/URI"),
    ("submitForm", b"/SubmitForm"),
    ("acroForm", b"/AcroForm"),
    ("xfa", b"/XFA"),
    ("richMedia", b"/RichMedia"),
    ("encrypt", b"/Encrypt"),
    ("objStm", b"/ObjStm"),
];

fn count_name(data: &[u8], name: &[u8]) -> usize {
    let mut count = 0;
    let mut from = 0;
    while let Some(at) = find(data, name, from) {
        // A name ends where a delimiter or white space starts: /JS is not /JSON.
        let next = data.get(at + name.len()).copied().unwrap_or(b' ');
        if !next.is_ascii_alphanumeric() {
            count += 1;
        }
        from = at + name.len();
        if count >= 10_000 {
            break;
        }
    }
    count
}

fn pdf(data: &[u8], fields: &mut Vec<DocField>, flags: &mut Vec<Flag>, budget: &Budget) {
    if let Some(version) = data
        .get(5..8)
        .filter(|v| v.iter().all(|b| b.is_ascii_digit() || *b == b'.'))
    {
        push_field(fields, "pdf", "Version", &String::from_utf8_lossy(version));
    }
    for key in PDF_KEYS {
        if budget.expired() {
            return;
        }
        let needle = format!("/{key}");
        // The last value wins: an incremental update appends a newer one.
        let mut from = 0;
        let mut last = None;
        while let Some(at) = find(data, needle.as_bytes(), from) {
            let mut i = at + needle.len();
            while data.get(i).is_some_and(|b| b.is_ascii_whitespace()) {
                i += 1;
            }
            if let Some(value) = data.get(i..).and_then(pdf_string) {
                last = Some(value);
            }
            from = at + needle.len();
        }
        if let Some(value) = last {
            let shown = if key.ends_with("Date") {
                pdf_date(&value)
            } else {
                value
            };
            push_field(fields, "pdf", key, &shown);
        }
    }
    for (key, name) in PDF_RISKY {
        if budget.expired() {
            return;
        }
        let count = count_name(data, name);
        if count > 0 {
            flags.push(Flag {
                key: (*key).into(),
                count,
            });
        }
    }
}

/* ---------------- ZIP (Office, OpenDocument) ---------------- */

struct ZipEntry {
    name: String,
    method: u16,
    compressed: usize,
    local_offset: usize,
}

fn le16(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

fn le32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

/// The central directory's entries, from the end record.
fn zip_entries(data: &[u8]) -> Vec<ZipEntry> {
    let mut entries = Vec::new();
    let search_from = data.len().saturating_sub(66_000);
    let Some(eocd) = (search_from..data.len().saturating_sub(21))
        .rev()
        .find(|&at| data.get(at..at + 4) == Some(b"PK\x05\x06"))
    else {
        return entries;
    };
    let (Some(count), Some(offset)) = (le16(data, eocd + 10), le32(data, eocd + 16)) else {
        return entries;
    };
    let mut at = offset as usize;
    for _ in 0..count.min(5000) {
        if data.get(at..at + 4) != Some(b"PK\x01\x02") {
            break;
        }
        let (
            Some(method),
            Some(compressed),
            Some(name_len),
            Some(extra),
            Some(comment),
            Some(local),
        ) = (
            le16(data, at + 10),
            le32(data, at + 20),
            le16(data, at + 28),
            le16(data, at + 30),
            le16(data, at + 32),
            le32(data, at + 42),
        )
        else {
            break;
        };
        let Some(name) = data.get(at + 46..at + 46 + name_len as usize) else {
            break;
        };
        entries.push(ZipEntry {
            name: String::from_utf8_lossy(name).into_owned(),
            method,
            compressed: compressed as usize,
            local_offset: local as usize,
        });
        at += 46 + name_len as usize + extra as usize + comment as usize;
    }
    entries
}

fn zip_read(data: &[u8], entry: &ZipEntry) -> Option<Vec<u8>> {
    let at = entry.local_offset;
    if data.get(at..at + 4) != Some(b"PK\x03\x04") {
        return None;
    }
    let start = at + 30 + le16(data, at + 26)? as usize + le16(data, at + 28)? as usize;
    let raw = data.get(start..start.checked_add(entry.compressed)?)?;
    match entry.method {
        0 => Some(raw.get(..raw.len().min(MAX_PART))?.to_vec()),
        8 => miniz_oxide::inflate::decompress_to_vec_with_limit(raw, MAX_PART).ok(),
        _ => None,
    }
}

fn office(data: &[u8], fields: &mut Vec<DocField>, flags: &mut Vec<Flag>) {
    let entries = zip_entries(data);
    for entry in &entries {
        let source = match entry.name.as_str() {
            "docProps/core.xml" | "docProps/app.xml" | "docProps/custom.xml" => "office",
            "meta.xml" => "odf",
            _ => continue,
        };
        if let Some(xml) = zip_read(data, entry) {
            office_properties(&xml, source, fields);
        }
    }
    let macros = entries
        .iter()
        .filter(|e| {
            let lower = e.name.to_ascii_lowercase();
            lower.ends_with("vbaproject.bin")
                || lower.starts_with("basic/")
                || lower.ends_with(".bin") && lower.contains("activex")
        })
        .count();
    if macros > 0 {
        flags.push(Flag {
            key: "macros".into(),
            count: macros,
        });
    }
    let external = entries
        .iter()
        .filter(|e| e.name.ends_with(".rels"))
        .filter_map(|e| zip_read(data, e))
        .map(|rels| count_name(&rels, b"TargetMode=\"External\""))
        .sum::<usize>();
    if external > 0 {
        flags.push(Flag {
            key: "externalLinks".into(),
            count: external,
        });
    }
}

/// core.xml and meta.xml use `prefix:Name`; app.xml uses bare names.
fn office_properties(xml: &[u8], source: &str, fields: &mut Vec<DocField>) {
    static BARE: OnceLock<Regex> = OnceLock::new();
    xml_properties(xml, source, fields);
    let bare = regex(
        &BARE,
        r"<([A-Z][A-Za-z]{1,40})>([^<]{1,300})</([A-Z][A-Za-z]{1,40})>",
    );
    for caps in bare.captures_iter(xml) {
        if caps[1] == caps[3] {
            push_field(
                fields,
                source,
                &String::from_utf8_lossy(&caps[1]),
                String::from_utf8_lossy(&caps[2]).trim(),
            );
        }
    }
}

/* ---------------- The report ---------------- */

fn observations(report: analysis::Report, run: &str, out: &mut Vec<Observation>) {
    for fact in report.facts {
        out.push(Observation {
            id: format!("{run}:{}", out.len()),
            key: fact.key.into(),
            value: fact.value,
            group: fact.group,
            hint: fact.hint.map(Into::into),
            items: fact.items,
        });
    }
}

/// Inspect the file at `path`. Only its name is reported, never its folder.
pub fn inspect(path: &Path) -> io::Result<MetadataReport> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a file"));
    }
    let name = path
        .file_name()
        .map(|n| clean(&n.to_string_lossy()))
        .unwrap_or_default();
    let mut data = Vec::new();
    File::open(path)?.take(CAP).read_to_end(&mut data)?;
    let extension = extension_of(&name);
    let kind = crate::investigation_files::detect_kind(
        &data[..data.len().min(4096)],
        extension.as_deref(),
    );
    let budget = Budget::new(TIME, CAP);
    let subject = Subject {
        path,
        kind,
        extension: extension.clone(),
    };

    let mut found = Vec::new();
    let mut tags = Vec::new();
    let mut limited = meta.len() > CAP;
    if let Ok(report) = analysis::identify::analyze(&subject, &budget) {
        observations(report, "identify", &mut found);
    }
    if matches!(kind, "jpeg" | "png") {
        if let Ok(report) = analysis::image::analyze(&subject, &budget) {
            limited |= report.limited;
            tags = report
                .body
                .lines()
                .skip(1)
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty() && line != "none")
                .take(MAX_TAGS)
                .collect();
            observations(report, "image", &mut found);
        }
    }
    if kind == "pe" {
        if let Ok(report) = analysis::pe::analyze(&subject, &budget) {
            limited |= report.limited;
            observations(report, "pe", &mut found);
        }
    }
    let gps = found
        .iter()
        .find(|o| o.key == "image.gps")
        .and_then(|o| o.value.as_str())
        .and_then(|text| {
            let (lat, lon) = text.split_once(", ")?;
            Some(Gps {
                lat: lat.trim().parse().ok()?,
                lon: lon.trim().parse().ok()?,
            })
        });

    let mut fields = Vec::new();
    let mut flags = Vec::new();
    if kind == "pdf" {
        pdf(&data, &mut fields, &mut flags, &budget);
    }
    if matches!(kind, "office" | "zip") {
        office(&data, &mut fields, &mut flags);
    }
    xmp(&data, &mut fields, &budget);
    limited |= budget.expired();

    Ok(MetadataReport {
        name,
        bytes: meta.len(),
        modified_ms: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64),
        kind: kind.into(),
        sha256: hex::encode(Sha256::digest(&data)),
        observations: found,
        tags,
        fields,
        flags,
        gps,
        limited,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(name: &str, bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        (dir, path)
    }

    fn field<'a>(report: &'a MetadataReport, key: &str) -> Option<&'a str> {
        report
            .fields
            .iter()
            .find(|f| f.key == key)
            .map(|f| f.value.as_str())
    }

    /// A JPEG with an Exif block naming a camera and a GPS position.
    fn jpeg_with_gps() -> Vec<u8> {
        // TIFF, big-endian: IFD0 with Make and a GPS pointer.
        let mut tiff = b"MM\x00\x2a\x00\x00\x00\x08".to_vec();
        let make = b"Canon\0";
        // IFD0: 2 entries.
        tiff.extend(2u16.to_be_bytes());
        tiff.extend(0x010Fu16.to_be_bytes()); // Make
        tiff.extend(2u16.to_be_bytes());
        tiff.extend((make.len() as u32).to_be_bytes());
        let make_at = 8 + 2 + 12 * 2 + 4;
        let gps_at = make_at + make.len() as u32;
        tiff.extend((make_at).to_be_bytes());
        tiff.extend(0x8825u16.to_be_bytes()); // GPS IFD
        tiff.extend(4u16.to_be_bytes());
        tiff.extend(1u32.to_be_bytes());
        tiff.extend(gps_at.to_be_bytes());
        tiff.extend(0u32.to_be_bytes());
        tiff.extend(make);
        // GPS IFD: LatRef, Lat, LonRef, Lon.
        let rationals_at = gps_at + 2 + 12 * 4 + 4;
        tiff.extend(4u16.to_be_bytes());
        for (tag, kind, count, value) in [
            (1u16, 2u16, 2u32, u32::from_be_bytes(*b"N\0\0\0")),
            (2, 5, 3, rationals_at),
            (3, 2, 2, u32::from_be_bytes(*b"E\0\0\0")),
            (4, 5, 3, rationals_at + 24),
        ] {
            tiff.extend(tag.to_be_bytes());
            tiff.extend(kind.to_be_bytes());
            tiff.extend(count.to_be_bytes());
            tiff.extend(value.to_be_bytes());
        }
        tiff.extend(0u32.to_be_bytes());
        for (num, den) in [(41, 1), (0, 1), (0, 1), (28, 1), (58, 1), (0, 1)] {
            tiff.extend((num as u32).to_be_bytes());
            tiff.extend((den as u32).to_be_bytes());
        }
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(&tiff);
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE1];
        jpeg.extend(((app1.len() + 2) as u16).to_be_bytes());
        jpeg.extend(app1);
        let xmp = br#"<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmp:CreatorTool="Adobe Photoshop 25.0" xmp:CreateDate="2026-01-02T10:00:00"><dc:creator><rdf:Seq><rdf:li>Jane &amp; Co</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>"#;
        jpeg.extend([0xFF, 0xE1]);
        jpeg.extend(((xmp.len() + 2 + 29) as u16).to_be_bytes());
        jpeg.extend(b"http://ns.adobe.com/xap/1.0/\0");
        jpeg.extend(xmp);
        jpeg.extend([0xFF, 0xD9]);
        jpeg
    }

    #[test]
    fn a_photo_shows_its_camera_location_and_xmp() {
        let (_dir, path) = write("IMG_0001.jpg", &jpeg_with_gps());
        let report = inspect(&path).unwrap();
        assert_eq!(report.name, "IMG_0001.jpg");
        assert_eq!(report.kind, "jpeg");
        assert!(report
            .observations
            .iter()
            .any(|o| o.key == "image.camera" && o.value == "Canon"));
        let gps = report.gps.clone().unwrap();
        assert!(
            (gps.lat - 41.0).abs() < 1e-6 && (gps.lon - 28.966_666).abs() < 1e-3,
            "{gps:?}"
        );
        assert!(
            report.tags.iter().any(|t| t.contains("Canon")),
            "{:?}",
            report.tags
        );
        assert_eq!(
            field(&report, "xmp:CreatorTool"),
            Some("Adobe Photoshop 25.0")
        );
        assert_eq!(field(&report, "dc:creator"), Some("Jane & Co"));
        assert_eq!(report.sha256.len(), 64);
    }

    #[test]
    fn a_pdf_shows_its_document_information_and_risky_names() {
        let pdf = b"%PDF-1.7\n1 0 obj << /Type /Catalog /OpenAction 2 0 R /Names << /JavaScript 3 0 R >> >> endobj\n2 0 obj << /S /JavaScript /JS (app.alert\\(1\\)) >> endobj\n4 0 obj << /Title (Quarterly \\(draft\\)) /Author <FEFF004A0061006E0065> /Producer (Acme PDF 1.0) /CreationDate (D:20240102030405+03'00') >> endobj\n4 0 obj << /Producer (Acme PDF 2.0) >> endobj\ntrailer << /Info 4 0 R /JSON 1 >>\n%%EOF";
        let (_dir, path) = write("report.pdf", pdf);
        let report = inspect(&path).unwrap();
        assert_eq!(report.kind, "pdf");
        assert_eq!(field(&report, "Version"), Some("1.7"));
        assert_eq!(field(&report, "Title"), Some("Quarterly (draft)"));
        assert_eq!(field(&report, "Author"), Some("Jane"));
        assert_eq!(
            field(&report, "Producer"),
            Some("Acme PDF 2.0"),
            "the newest value wins"
        );
        assert_eq!(
            field(&report, "CreationDate"),
            Some("2024-01-02 03:04:05 +03:00")
        );
        let flag = |key: &str| report.flags.iter().find(|f| f.key == key).map(|f| f.count);
        assert_eq!(flag("openAction"), Some(1));
        assert_eq!(flag("javascript"), Some(2));
        assert_eq!(flag("js"), Some(1), "/JSON is not /JS");
        assert_eq!(flag("launch"), None);
    }

    fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        // Stored entries only: enough to test the reader.
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, body) in entries {
            let offset = out.len() as u32;
            out.extend(b"PK\x03\x04");
            out.extend([20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend((body.len() as u32).to_le_bytes());
            out.extend((body.len() as u32).to_le_bytes());
            out.extend((name.len() as u16).to_le_bytes());
            out.extend(0u16.to_le_bytes());
            out.extend(name.as_bytes());
            out.extend(*body);
            central.extend(b"PK\x01\x02");
            central.extend([20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend((body.len() as u32).to_le_bytes());
            central.extend((body.len() as u32).to_le_bytes());
            central.extend((name.len() as u16).to_le_bytes());
            central.extend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend(offset.to_le_bytes());
            central.extend(name.as_bytes());
        }
        let central_at = out.len() as u32;
        out.extend(&central);
        out.extend(b"PK\x05\x06");
        out.extend([0, 0, 0, 0]);
        out.extend((entries.len() as u16).to_le_bytes());
        out.extend((entries.len() as u16).to_le_bytes());
        out.extend((central.len() as u32).to_le_bytes());
        out.extend(central_at.to_le_bytes());
        out.extend(0u16.to_le_bytes());
        out
    }

    #[test]
    fn an_office_file_shows_its_properties_and_macros() {
        let core = br#"<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:creator>Mert</dc:creator><cp:lastModifiedBy>Ayse</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T09:00:00Z</dcterms:created></cp:coreProperties>"#;
        let app = br#"<?xml version="1.0"?><Properties><Application>Microsoft Office Word</Application><Company>Qutra</Company><TotalTime>42</TotalTime></Properties>"#;
        let rels = br#"<Relationships><Relationship Id="r1" Target="https://evil.example/x.dotm" TargetMode="External"/></Relationships>"#;
        let bytes = zip(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("docProps/core.xml", core),
            ("docProps/app.xml", app),
            ("word/_rels/settings.xml.rels", rels),
            ("word/vbaProject.bin", b"\xD0\xCF\x11\xE0"),
        ]);
        let (_dir, path) = write("invoice.docm", &bytes);
        let report = inspect(&path).unwrap();
        assert_eq!(field(&report, "dc:creator"), Some("Mert"));
        assert_eq!(field(&report, "cp:lastModifiedBy"), Some("Ayse"));
        assert_eq!(
            field(&report, "dcterms:created"),
            Some("2026-01-01T09:00:00Z")
        );
        assert_eq!(field(&report, "Application"), Some("Microsoft Office Word"));
        assert_eq!(field(&report, "Company"), Some("Qutra"));
        assert!(report.flags.iter().any(|f| f.key == "macros"));
        assert!(report.flags.iter().any(|f| f.key == "externalLinks"));
    }

    #[test]
    fn a_deflated_part_is_inflated_within_its_cap() {
        let xml = br#"<cp:coreProperties><dc:title>Deflated title</dc:title></cp:coreProperties>"#;
        let compressed = miniz_oxide::deflate::compress_to_vec(xml, 6);
        let mut bytes = zip(&[("docProps/core.xml", &compressed)]);
        // Mark the entry deflated (method 8) in both headers.
        bytes[8] = 8;
        let central = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        bytes[central + 10] = 8;
        // The central record still gives the compressed size.
        let (_dir, path) = write("x.xlsx", &bytes);
        let report = inspect(&path).unwrap();
        assert_eq!(field(&report, "dc:title"), Some("Deflated title"));
    }

    #[test]
    fn plain_text_has_no_metadata_and_says_so() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"just text").unwrap();
        let report = inspect(file.path()).unwrap();
        assert!(report.fields.is_empty());
        assert!(report.flags.is_empty());
        assert!(report.gps.is_none());
        assert!(report.observations.iter().any(|o| o.key == "identify.kind"));
        assert_eq!(pdf_date("D:2024"), "D:2024");
        assert_eq!(pdf_date("D:20240102"), "2024-01-02");
        assert_eq!(pdf_date("D:20240102030405Z"), "2024-01-02 03:04:05 UTC");
        assert_eq!(
            unescape_xml("a &lt;b&gt; &#65;&#x42; &bogus; &"),
            "a <b> AB &bogus; &"
        );
    }
}
