//! Files hidden inside the file (§6.2 "embedded signatures"): known headers
//! found after its start. A short magic is checked further (a PE header
//! where `MZ` points, a JPEG marker…) so chance matches are not reported.

use std::{io, ops::Range};

use super::{
    scan::{each_chunk, Budget},
    Fact, Group, Report, Subject, MAX_ITEMS,
};

/// Enough after a match to check it: `MZ`'s PE header lies within 4 KiB.
const LOOKAHEAD: usize = 4096 + 8;
const MAX_HITS: usize = 200;
/// Formats whose own entries begin with an archive's header.
const CONTAINERS: &[&str] = &["zip", "office", "7z", "rar", "gzip"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Program,
    Archive,
    Other,
}

struct Signature {
    code: &'static str,
    magic: &'static [u8],
    class: Class,
    check: fn(&[u8]) -> bool,
}

const SIGNATURES: &[Signature] = &[
    Signature {
        code: "pe",
        magic: b"MZ",
        class: Class::Program,
        check: pe_header,
    },
    Signature {
        code: "elf",
        magic: b"\x7FELF",
        class: Class::Program,
        check: elf_header,
    },
    Signature {
        code: "zip",
        magic: b"PK\x03\x04",
        class: Class::Archive,
        check: zip_header,
    },
    Signature {
        code: "7z",
        magic: b"7z\xBC\xAF\x27\x1C",
        class: Class::Archive,
        check: whole,
    },
    Signature {
        code: "rar",
        magic: b"Rar!\x1A\x07",
        class: Class::Archive,
        check: whole,
    },
    Signature {
        code: "cab",
        magic: b"MSCF\0\0\0\0",
        class: Class::Archive,
        check: whole,
    },
    Signature {
        code: "ole",
        magic: b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1",
        class: Class::Other,
        check: whole,
    },
    Signature {
        code: "pdf",
        magic: b"%PDF-1.",
        class: Class::Other,
        check: whole,
    },
    Signature {
        code: "png",
        magic: b"\x89PNG\r\n\x1A\n",
        class: Class::Other,
        check: whole,
    },
    Signature {
        code: "jpeg",
        magic: b"\xFF\xD8\xFF",
        class: Class::Other,
        check: jpeg_marker,
    },
    Signature {
        code: "sqlite",
        magic: b"SQLite format 3\0",
        class: Class::Other,
        check: whole,
    },
];

fn whole(_: &[u8]) -> bool {
    true
}

/// `MZ`, then `PE\0\0` where its header's offset points, within 4 KiB.
fn pe_header(at: &[u8]) -> bool {
    let Some(word) = at.get(0x3C..0x40) else {
        return false;
    };
    let offset = u32::from_le_bytes([word[0], word[1], word[2], word[3]]) as usize;
    (0x40..=0x1000).contains(&offset) && at.get(offset..offset + 4) == Some(b"PE\0\0".as_slice())
}

fn elf_header(at: &[u8]) -> bool {
    matches!(at.get(4), Some(1 | 2)) && matches!(at.get(5), Some(1 | 2)) && at.get(6) == Some(&1)
}

fn zip_header(at: &[u8]) -> bool {
    at.get(4).is_some_and(|version| *version <= 63) && at.get(5) == Some(&0)
}

fn jpeg_marker(at: &[u8]) -> bool {
    at.get(3)
        .is_some_and(|marker| (0xE0..=0xEF).contains(marker) || *marker == 0xDB)
}

/// One class's hits: all of them counted, the first ones kept as examples.
#[derive(Default)]
struct ClassHits {
    total: usize,
    items: Vec<String>,
}

struct Hits {
    by_first: Vec<Vec<usize>>,
    /// The first hits of any class, for the raw output.
    listed: Vec<(u64, usize)>,
    total: usize,
    // Counted apart, so hundreds of pictures cannot crowd a program out.
    programs: ClassHits,
    archives: ClassHits,
    others: ClassHits,
}

impl Hits {
    fn new() -> Self {
        let mut by_first = vec![Vec::new(); 256];
        for (index, signature) in SIGNATURES.iter().enumerate() {
            by_first[signature.magic[0] as usize].push(index);
        }
        Self {
            by_first,
            listed: Vec::new(),
            total: 0,
            programs: ClassHits::default(),
            archives: ClassHits::default(),
            others: ClassHits::default(),
        }
    }

    /// Look for signatures starting in `range` of `window`, which begins at
    /// `start` in the file.
    fn scan(&mut self, window: &[u8], start: u64, range: Range<usize>) {
        for i in range {
            for &index in &self.by_first[window[i] as usize] {
                let signature = &SIGNATURES[index];
                let at = &window[i..];
                let offset = start + i as u64;
                if offset == 0 || !at.starts_with(signature.magic) || !(signature.check)(at) {
                    continue;
                }
                self.total += 1;
                if self.listed.len() < MAX_HITS {
                    self.listed.push((offset, index));
                }
                let class = match signature.class {
                    Class::Program => &mut self.programs,
                    Class::Archive => &mut self.archives,
                    Class::Other => &mut self.others,
                };
                class.total += 1;
                if class.items.len() < MAX_ITEMS {
                    class
                        .items
                        .push(format!("{} @ 0x{offset:08X}", signature.code));
                }
            }
        }
    }
}

pub fn analyze(subject: &Subject, budget: &Budget) -> io::Result<Report> {
    let mut hits = Hits::new();
    let mut window: Vec<u8> = Vec::new();
    let mut start: u64 = 0;
    let scanned = each_chunk(subject.path, budget, |_, chunk| {
        window.extend_from_slice(chunk);
        // A match near the end is checked next time, with what follows it.
        let upto = window.len().saturating_sub(LOOKAHEAD);
        hits.scan(&window, start, 0..upto);
        window.drain(..upto);
        start += upto as u64;
    })?;
    hits.scan(&window, start, 0..window.len());

    let mut facts = vec![Fact::new(Group::Summary, "signatures.count", hits.total)];
    let Hits {
        programs,
        archives,
        others,
        ..
    } = &hits;
    if programs.total > 0 {
        facts.push(
            Fact::new(Group::Interesting, "signatures.executable", programs.total)
                .hint("embeddedExecutable")
                .items(programs.items.clone()),
        );
    }
    if archives.total > 0 {
        let fact = if CONTAINERS.contains(&subject.kind) {
            Fact::new(Group::Detail, "signatures.archive", archives.total)
        } else {
            Fact::new(Group::Interesting, "signatures.archive", archives.total)
                .hint("embeddedArchive")
        };
        facts.push(fact.items(archives.items.clone()));
    }
    if others.total > 0 {
        facts.push(
            Fact::new(Group::Detail, "signatures.other", others.total).items(others.items.clone()),
        );
    }
    let mut body = format!(
        "Known file headers after the start of the file, in {} bytes: {}\n",
        scanned.read, hits.total
    );
    for (offset, index) in &hits.listed {
        body.push_str(&format!("0x{offset:08X}  {}\n", SIGNATURES[*index].code));
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

    /// A minimal PE header: `MZ`, its pointer at 0x3C, `PE\0\0` at 0x80.
    fn pe() -> Vec<u8> {
        let mut bytes = vec![0u8; 0x100];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes
    }

    fn fact<'a>(report: &'a Report, key: &str) -> Option<&'a Fact> {
        report.facts.iter().find(|fact| fact.key == key)
    }

    #[test]
    fn a_program_hidden_in_a_picture_is_found_and_checked() {
        let mut bytes = b"\xFF\xD8\xFF\xE0".to_vec();
        bytes.resize(1000, 0x11);
        bytes.extend(pe());
        // `MZ` with no PE header behind it is chance, not a program.
        bytes.extend_from_slice(b"MZ is a word here");
        let file = sample(&bytes);
        let report = analyze(&subject(&file, "jpeg", Some("jpg")), &budget()).unwrap();
        let programs = fact(&report, "signatures.executable").unwrap();
        assert_eq!(programs.items, vec!["pe @ 0x000003E8"]);
        assert_eq!(programs.hint, Some("embeddedExecutable"));
        // The picture's own header at offset 0 is not a hidden file.
        assert_eq!(fact(&report, "signatures.count").unwrap().value, 1);
    }

    #[test]
    fn an_archive_stands_out_in_a_picture_but_not_in_an_archive() {
        let mut bytes = b"\x89PNG\r\n\x1A\n".to_vec();
        bytes.resize(500, 0);
        bytes.extend_from_slice(b"PK\x03\x04\x14\x00\x00\x00");
        let file = sample(&bytes);
        let in_picture = analyze(&subject(&file, "png", None), &budget()).unwrap();
        assert_eq!(
            fact(&in_picture, "signatures.archive").unwrap().group,
            Group::Interesting
        );
        let in_zip = analyze(&subject(&file, "zip", None), &budget()).unwrap();
        assert_eq!(
            fact(&in_zip, "signatures.archive").unwrap().group,
            Group::Detail
        );
    }

    #[test]
    fn many_pictures_do_not_crowd_a_program_out() {
        // 250 JPEG headers, then a program: past the 200 hits kept for the
        // raw output, the program still stands out.
        let mut bytes: Vec<u8> = (0..250).flat_map(|_| *b"\xFF\xD8\xFF\xE0").collect();
        bytes.extend(pe());
        let file = sample(&bytes);
        let report = analyze(&subject(&file, "jpeg", None), &budget()).unwrap();
        let programs = fact(&report, "signatures.executable").unwrap();
        assert_eq!(programs.value, 1);
        assert_eq!(programs.items, vec!["pe @ 0x000003E8"]);
        assert_eq!(fact(&report, "signatures.count").unwrap().value, 250);
        assert_eq!(fact(&report, "signatures.other").unwrap().value, 249);
        assert_eq!(fact(&report, "signatures.other").unwrap().items.len(), 20);
    }

    #[test]
    fn a_signature_across_two_reads_is_found_once() {
        // 1 MiB reads: the PE starts 2 bytes before the first read ends.
        let mut bytes = vec![0x22u8; (1 << 20) - 2];
        bytes.extend(pe());
        bytes.resize(3 << 20, 0x22);
        let file = sample(&bytes);
        let report = analyze(&subject(&file, "binary", None), &budget()).unwrap();
        assert_eq!(
            fact(&report, "signatures.executable").unwrap().items,
            vec![format!("pe @ 0x{:08X}", (1 << 20) - 2)]
        );
        assert_eq!(fact(&report, "signatures.count").unwrap().value, 1);
    }
}
