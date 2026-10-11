//! A photo's metadata (§6.2 "image metadata"): the camera, when it was
//! taken, the software, where it was taken and who owns it, from a JPEG's
//! Exif or a PNG's text and eXIf chunks. Every read is bounds-checked, loops
//! between directories are cut, and nothing about a location is looked up.

use std::{
    collections::HashSet,
    fs::File,
    io::{self, Read},
};

use super::{clean_text, scan::Budget, Fact, Group, Report, Subject};

const CAP: u64 = 64 * 1024 * 1024;
const MAX_SEGMENTS: usize = 512;
const MAX_CHUNKS: usize = 1000;
const MAX_ENTRIES: usize = 512;
const MAX_TEXTS: usize = 64;
/// The bytes of one text value read; more could never be shown.
const MAX_TEXT_BYTES: usize = 256;

const EXIF_IFD: u16 = 0x8769;
const GPS_IFD: u16 = 0x8825;

#[derive(Default)]
struct Meta {
    make: Option<String>,
    model: Option<String>,
    software: Option<String>,
    date: Option<String>,
    date_original: Option<String>,
    artist: Option<String>,
    owner: Option<String>,
    serial: Option<String>,
    lat_ref: Option<String>,
    lat: Vec<f64>,
    lon_ref: Option<String>,
    lon: Vec<f64>,
    texts: Vec<String>,
    compressed_texts: usize,
    /// Every tag read, for the raw output.
    lines: Vec<String>,
    /// A segment or chunk limit, or the time budget, stopped the reading.
    cut_short: bool,
}

struct Tiff<'a> {
    data: &'a [u8],
    big: bool,
}

struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    /// Where the entry's 4-byte value field is.
    at: usize,
}

impl<'a> Tiff<'a> {
    fn parse(data: &'a [u8]) -> Option<Self> {
        let big = match data.get(..2)? {
            b"MM" => true,
            b"II" => false,
            _ => return None,
        };
        let tiff = Self { data, big };
        (tiff.u16(2)? == 42).then_some(tiff)
    }

    fn u16(&self, at: usize) -> Option<u16> {
        let b = self.data.get(at..at.checked_add(2)?)?;
        Some(if self.big {
            u16::from_be_bytes([b[0], b[1]])
        } else {
            u16::from_le_bytes([b[0], b[1]])
        })
    }

    fn u32(&self, at: usize) -> Option<u32> {
        let b = self.data.get(at..at.checked_add(4)?)?;
        let bytes = [b[0], b[1], b[2], b[3]];
        Some(if self.big {
            u32::from_be_bytes(bytes)
        } else {
            u32::from_le_bytes(bytes)
        })
    }

    fn entries(&self, offset: usize) -> Vec<Entry> {
        let count = self.u16(offset).map_or(0, usize::from).min(MAX_ENTRIES);
        (0..count)
            .map_while(|n| {
                let at = offset + 2 + n * 12;
                Some(Entry {
                    tag: self.u16(at)?,
                    kind: self.u16(at + 2)?,
                    count: self.u32(at + 4)?,
                    at: at + 8,
                })
            })
            .collect()
    }

    /// Where an entry's value is and how long: in place when it fits in 4
    /// bytes, else where its offset points; only when all of it is there.
    fn span(&self, entry: &Entry) -> Option<(usize, usize)> {
        let unit: usize = match entry.kind {
            1 | 2 | 6 | 7 => 1,
            3 | 8 => 2,
            4 | 9 | 11 => 4,
            5 | 10 | 12 => 8,
            _ => return None,
        };
        let len = unit.checked_mul(entry.count as usize)?;
        let start = if len <= 4 {
            entry.at
        } else {
            self.u32(entry.at)? as usize
        };
        self.data.get(start..start.checked_add(len)?)?;
        Some((start, len))
    }

    fn value(&self, entry: &Entry) -> Option<&'a [u8]> {
        let (start, len) = self.span(entry)?;
        self.data.get(start..start + len)
    }

    fn ascii(&self, entry: &Entry) -> Option<String> {
        if entry.kind != 2 {
            return None;
        }
        // Read no further than a shown value could be: many entries can
        // point at one long blob, and each would be scanned again.
        let bytes = self.value(entry)?;
        let bytes = &bytes[..bytes.len().min(MAX_TEXT_BYTES)];
        let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
        let text = clean_text(&String::from_utf8_lossy(&bytes[..end]));
        (!text.is_empty()).then_some(text)
    }

    fn rationals(&self, entry: &Entry) -> Vec<f64> {
        if entry.kind != 5 {
            return Vec::new();
        }
        let Some((start, _)) = self.span(entry) else {
            return Vec::new();
        };
        // Degrees, minutes and seconds: never more than three are used.
        (0..(entry.count as usize).min(3))
            .map_while(|n| {
                let numerator = self.u32(start + n * 8)?;
                let denominator = self.u32(start + n * 8 + 4)?;
                Some(if denominator == 0 {
                    0.0
                } else {
                    f64::from(numerator) / f64::from(denominator)
                })
            })
            .collect()
    }

    fn pointer(&self, entry: &Entry) -> Option<usize> {
        if matches!(entry.kind, 4 | 13) {
            self.u32(entry.at).map(|v| v as usize)
        } else {
            None
        }
    }
}

fn read_tiff(data: &[u8], meta: &mut Meta, budget: &Budget) {
    let Some(tiff) = Tiff::parse(data) else {
        return;
    };
    let Some(first) = tiff.u32(4) else {
        return;
    };
    let mut seen = HashSet::new();
    let mut queue = vec![("IFD0", first as usize)];
    // One Exif and one GPS directory: IFD0 could point at hundreds.
    let (mut exif_followed, mut gps_followed) = (false, false);
    while let Some((name, offset)) = queue.pop() {
        if budget.expired() {
            meta.cut_short = true;
            return;
        }
        if !seen.insert(offset) {
            continue;
        }
        for entry in tiff.entries(offset) {
            // Only the tags shown are read.
            let mut text = |label: &str| {
                let value = tiff.ascii(&entry);
                if let Some(value) = &value {
                    meta.lines.push(format!("{name} {label}: {value}"));
                }
                value
            };
            match (name, entry.tag) {
                ("IFD0", 0x010F) => meta.make = text("Make"),
                ("IFD0", 0x0110) => meta.model = text("Model"),
                ("IFD0", 0x0131) => meta.software = text("Software"),
                ("IFD0", 0x0132) => meta.date = text("DateTime"),
                ("IFD0", 0x013B) => meta.artist = text("Artist"),
                ("IFD0", EXIF_IFD) if !exif_followed => {
                    if let Some(at) = tiff.pointer(&entry) {
                        exif_followed = true;
                        queue.push(("Exif", at));
                    }
                }
                ("IFD0", GPS_IFD) if !gps_followed => {
                    if let Some(at) = tiff.pointer(&entry) {
                        gps_followed = true;
                        queue.push(("GPS", at));
                    }
                }
                ("Exif", 0x9003) => meta.date_original = text("DateTimeOriginal"),
                ("Exif", 0xA430) => meta.owner = text("CameraOwnerName"),
                ("Exif", 0xA431) => meta.serial = text("BodySerialNumber"),
                ("GPS", 0x0001) => meta.lat_ref = text("GPSLatitudeRef"),
                ("GPS", 0x0002) => meta.lat = tiff.rationals(&entry),
                ("GPS", 0x0003) => meta.lon_ref = text("GPSLongitudeRef"),
                ("GPS", 0x0004) => meta.lon = tiff.rationals(&entry),
                _ => {}
            }
        }
    }
}

/// A JPEG's Exif block: the APP1 segment that starts with `Exif\0\0`.
/// `cut` is set when the segment limit stopped the walk.
fn jpeg_exif<'a>(data: &'a [u8], cut: &mut bool) -> Option<&'a [u8]> {
    if !data.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut at = 2;
    for n in 0..=MAX_SEGMENTS {
        if n == MAX_SEGMENTS {
            *cut = true;
            return None;
        }
        if *data.get(at)? != 0xFF {
            return None;
        }
        let marker = *data.get(at + 1)?;
        if marker == 0xFF {
            // A fill byte before the marker.
            at += 1;
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            return None;
        }
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            at += 2;
            continue;
        }
        let len = usize::from(u16::from_be_bytes([*data.get(at + 2)?, *data.get(at + 3)?]));
        if len < 2 {
            return None;
        }
        let payload = data.get(at + 4..at + 2 + len)?;
        if marker == 0xE1 && payload.starts_with(b"Exif\0\0") {
            return Some(&payload[6..]);
        }
        at += 2 + len;
    }
    None
}

/// Latin-1 text, only as much as could be shown.
fn latin1(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take(MAX_TEXT_BYTES)
        .map(|&b| b as char)
        .collect()
}

/// A PNG's text chunks, and its Exif when it has an eXIf chunk.
fn png_chunks(data: &[u8], meta: &mut Meta, budget: &Budget) {
    if !data.starts_with(b"\x89PNG\r\n\x1A\n") {
        return;
    }
    let mut at = 8usize;
    for n in 0..=MAX_CHUNKS {
        if n == MAX_CHUNKS || budget.expired() {
            meta.cut_short = true;
            return;
        }
        let Some(len) = data
            .get(at..at + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
        else {
            return;
        };
        let Some(kind) = data.get(at + 4..at + 8) else {
            return;
        };
        let Some(body) = at
            .checked_add(8 + len)
            .and_then(|end| data.get(at + 8..end))
        else {
            return;
        };
        let mut text = |keyword: &str, value: &str| {
            if meta.texts.len() < MAX_TEXTS {
                meta.texts
                    .push(format!("{}: {}", clean_text(keyword), clean_text(value)));
            }
        };
        match kind {
            b"tEXt" => {
                if let Some(nul) = body.iter().position(|&b| b == 0) {
                    text(&latin1(&body[..nul]), &latin1(&body[nul + 1..]));
                }
            }
            b"iTXt" => {
                let mut parts = body.splitn(2, |&b| b == 0);
                let keyword = parts.next().unwrap_or_default();
                let rest = parts.next().unwrap_or_default();
                if rest.first() == Some(&0) {
                    // Not compressed: method, language\0, translated keyword\0, text.
                    let mut tail = rest.get(2..).unwrap_or_default().splitn(3, |&b| b == 0);
                    let _language = tail.next();
                    let _translated = tail.next();
                    let value = tail.next().unwrap_or_default();
                    let value = &value[..value.len().min(MAX_TEXT_BYTES * 4)];
                    text(&latin1(keyword), &String::from_utf8_lossy(value));
                } else {
                    meta.compressed_texts += 1;
                }
            }
            b"zTXt" => meta.compressed_texts += 1,
            b"eXIf" => read_tiff(body, meta, budget),
            b"IEND" => return,
            _ => {}
        }
        at += 12 + len;
    }
}

/// Degrees, minutes and seconds as signed decimal degrees.
fn degrees(reference: &Option<String>, dms: &[f64], negative: &str) -> Option<f64> {
    if dms.len() < 3 {
        return None;
    }
    let value = dms[0] + dms[1] / 60.0 + dms[2] / 3600.0;
    Some(if reference.as_deref() == Some(negative) {
        -value
    } else {
        value
    })
}

impl Meta {
    fn location(&self) -> Option<(f64, f64)> {
        Some((
            degrees(&self.lat_ref, &self.lat, "S")?,
            degrees(&self.lon_ref, &self.lon, "W")?,
        ))
    }
}

pub fn analyze(subject: &Subject, budget: &Budget) -> io::Result<Report> {
    let size = std::fs::metadata(subject.path)?.len();
    let mut data = Vec::new();
    File::open(subject.path)?.take(CAP).read_to_end(&mut data)?;
    let mut meta = Meta::default();
    let mut cut = false;
    if let Some(exif) = jpeg_exif(&data, &mut cut) {
        read_tiff(exif, &mut meta, budget);
    }
    meta.cut_short |= cut;
    png_chunks(&data, &mut meta, budget);

    let mut facts = Vec::new();
    let camera = match (&meta.make, &meta.model) {
        (Some(make), Some(model)) if model.starts_with(make.as_str()) => Some(model.clone()),
        (Some(make), Some(model)) => Some(format!("{make} {model}")),
        (make, model) => make.clone().or_else(|| model.clone()),
    };
    if let Some(camera) = camera {
        facts.push(Fact::new(Group::Summary, "image.camera", camera));
    }
    if let Some(taken) = meta.date_original.clone().or_else(|| meta.date.clone()) {
        facts.push(Fact::new(Group::Summary, "image.taken", taken));
    }
    if let Some(software) = meta.software.clone() {
        facts.push(Fact::new(Group::Summary, "image.software", software));
    }
    if let Some((lat, lon)) = meta.location() {
        facts.push(
            Fact::new(
                Group::Interesting,
                "image.gps",
                format!("{lat:.6}, {lon:.6}"),
            )
            .hint("gpsLocation"),
        );
    }
    let owners: Vec<String> = [meta.artist.clone(), meta.owner.clone()]
        .into_iter()
        .flatten()
        .collect();
    if !owners.is_empty() {
        facts.push(
            Fact::new(Group::Interesting, "image.owner", owners.join(" · ")).hint("identifying"),
        );
    }
    if let Some(serial) = meta.serial.clone() {
        facts.push(Fact::new(Group::Interesting, "image.serial", serial).hint("identifying"));
    }
    if !meta.texts.is_empty() {
        facts.push(
            Fact::new(Group::Detail, "image.text", meta.texts.len()).items(meta.texts.clone()),
        );
    }
    if facts.is_empty() {
        facts.push(Fact::new(Group::Summary, "image.none", "none"));
    }

    let mut body = String::from("Metadata read from the file:\n");
    for line in &meta.lines {
        body.push_str(&format!("  {line}\n"));
    }
    if let Some((lat, lon)) = meta.location() {
        body.push_str(&format!("  GPS: {lat:.6}, {lon:.6}\n"));
    }
    for text in &meta.texts {
        body.push_str(&format!("  PNG text {text}\n"));
    }
    if meta.compressed_texts > 0 {
        body.push_str(&format!(
            "  {} compressed text chunk(s), not read\n",
            meta.compressed_texts
        ));
    }
    if meta.lines.is_empty() && meta.texts.is_empty() {
        body.push_str("  none\n");
    }
    Ok(Report {
        facts,
        body,
        limited: size > CAP || meta.cut_short,
    })
}

#[cfg(test)]
mod tests {
    use super::super::testing::{budget, sample, subject};
    use super::*;

    fn entry(t: &mut Vec<u8>, tag: u16, kind: u16, count: u32, value: u32) {
        t.extend(tag.to_be_bytes());
        t.extend(kind.to_be_bytes());
        t.extend(count.to_be_bytes());
        t.extend(value.to_be_bytes());
    }

    /// Big-endian Exif: IFD0 (Make, Model, Software, DateTime, Exif and GPS
    /// pointers), an Exif IFD (DateTimeOriginal, BodySerialNumber), a GPS IFD
    /// at N 41°0'29.52" E 28°58'42.24", then the data they point at.
    fn exif_tiff() -> Vec<u8> {
        let mut t = b"MM\0\x2A\0\0\0\x08".to_vec();
        t.extend(6u16.to_be_bytes());
        entry(&mut t, 0x010F, 2, 6, 170);
        entry(&mut t, 0x0110, 2, 7, 176);
        entry(&mut t, 0x0131, 2, 10, 183);
        entry(&mut t, 0x0132, 2, 20, 193);
        entry(&mut t, EXIF_IFD, 4, 1, 86);
        entry(&mut t, GPS_IFD, 4, 1, 116);
        t.extend(0u32.to_be_bytes());
        assert_eq!(t.len(), 86);
        t.extend(2u16.to_be_bytes());
        entry(&mut t, 0x9003, 2, 20, 213);
        entry(&mut t, 0xA431, 2, 7, 233);
        t.extend(0u32.to_be_bytes());
        assert_eq!(t.len(), 116);
        t.extend(4u16.to_be_bytes());
        entry(&mut t, 0x0001, 2, 2, u32::from_be_bytes(*b"N\0\0\0"));
        entry(&mut t, 0x0002, 5, 3, 240);
        entry(&mut t, 0x0003, 2, 2, u32::from_be_bytes(*b"E\0\0\0"));
        entry(&mut t, 0x0004, 5, 3, 264);
        t.extend(0u32.to_be_bytes());
        assert_eq!(t.len(), 170);
        for text in [
            &b"Canon\0"[..],
            b"EOS R6\0",
            b"GIMP 2.10\0",
            b"2024:05:01 10:00:00\0",
            b"2024:05:01 09:59:58\0",
            b"123456\0",
        ] {
            t.extend_from_slice(text);
        }
        assert_eq!(t.len(), 240);
        for (n, d) in [
            (41u32, 1u32),
            (0, 1),
            (2952, 100),
            (28, 1),
            (58, 1),
            (4224, 100),
        ] {
            t.extend(n.to_be_bytes());
            t.extend(d.to_be_bytes());
        }
        t
    }

    fn jpeg_with(tiff: &[u8]) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xE1];
        j.extend(((2 + 6 + tiff.len()) as u16).to_be_bytes());
        j.extend_from_slice(b"Exif\0\0");
        j.extend_from_slice(tiff);
        j.extend([0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]);
        j
    }

    fn png_with(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut p = b"\x89PNG\r\n\x1A\n".to_vec();
        for (kind, body) in chunks {
            p.extend((body.len() as u32).to_be_bytes());
            p.extend_from_slice(*kind);
            p.extend_from_slice(body);
            p.extend([0u8; 4]);
        }
        p
    }

    fn fact<'a>(report: &'a Report, key: &str) -> Option<&'a Fact> {
        report.facts.iter().find(|fact| fact.key == key)
    }

    #[test]
    fn a_photo_s_camera_date_and_location_are_read() {
        let file = sample(&jpeg_with(&exif_tiff()));
        let report = analyze(&subject(&file, "jpeg", Some("jpg")), &budget()).unwrap();
        assert_eq!(fact(&report, "image.camera").unwrap().value, "Canon EOS R6");
        assert_eq!(
            fact(&report, "image.taken").unwrap().value,
            "2024:05:01 09:59:58"
        );
        assert_eq!(fact(&report, "image.software").unwrap().value, "GIMP 2.10");
        let gps = fact(&report, "image.gps").unwrap();
        assert_eq!(
            (gps.value.as_str(), gps.hint),
            (Some("41.008200, 28.978400"), Some("gpsLocation"))
        );
        assert_eq!(
            fact(&report, "image.serial").unwrap().hint,
            Some("identifying")
        );
        assert!(report.body.contains("IFD0 Make: Canon"));
    }

    #[test]
    fn one_exif_directory_is_followed_however_many_are_named() {
        // IFD0 names two Exif directories; reading every one would let a
        // small file make the reader scan the same bytes again and again.
        let mut t = b"MM\0\x2A\0\0\0\x08".to_vec();
        t.extend(2u16.to_be_bytes());
        entry(&mut t, EXIF_IFD, 4, 1, 38);
        entry(&mut t, EXIF_IFD, 4, 1, 56);
        t.extend(0u32.to_be_bytes());
        for &owner in b"AB" {
            t.extend(1u16.to_be_bytes());
            entry(&mut t, 0xA430, 2, 2, u32::from_be_bytes([owner, 0, 0, 0]));
            t.extend(0u32.to_be_bytes());
        }
        let file = sample(&jpeg_with(&t));
        let report = analyze(&subject(&file, "jpeg", None), &budget()).unwrap();
        assert_eq!(fact(&report, "image.owner").unwrap().value, "A");
    }

    #[test]
    fn png_text_is_read() {
        let file = sample(&png_with(&[
            (b"tEXt", b"Author\0Ay\xE7a"),
            (b"iTXt", b"Comment\0\0\0tr\0\0Merhaba d\xC3\xBCnya"),
            (b"zTXt", b"Note\0\0xx"),
            (b"IEND", b""),
        ]));
        let report = analyze(&subject(&file, "png", None), &budget()).unwrap();
        assert_eq!(
            fact(&report, "image.text").unwrap().items,
            vec!["Author: Ayça", "Comment: Merhaba dünya"]
        );
        assert!(report.body.contains("1 compressed text chunk(s), not read"));
    }

    #[test]
    fn broken_metadata_is_said_not_panicked_over() {
        // An IFD that claims 65,535 entries and a GPS IFD that points at
        // IFD0 again: what is there is read, once.
        let mut tiff = b"MM\0\x2A\0\0\0\x08\xFF\xFF".to_vec();
        entry(&mut tiff, GPS_IFD, 4, 1, 8);
        let file = sample(&jpeg_with(&tiff));
        let report = analyze(&subject(&file, "jpeg", None), &budget()).unwrap();
        assert_eq!(fact(&report, "image.none").unwrap().value, "none");
        // A chunk longer than the file.
        let mut png = b"\x89PNG\r\n\x1A\n".to_vec();
        png.extend(0xFFFF_FFF0u32.to_be_bytes());
        png.extend_from_slice(b"tEXt");
        let file = sample(&png);
        let report = analyze(&subject(&file, "png", None), &budget()).unwrap();
        assert_eq!(fact(&report, "image.none").unwrap().value, "none");
    }
}
