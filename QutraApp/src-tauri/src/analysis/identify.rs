//! What the file is by its first bytes, and whether its name says the same
//! (§6.2 "identify").

use std::io;

use super::{
    scan::{head, Budget},
    Fact, Group, Report, Subject,
};
use crate::investigation_files::detect_kind;

/// The kind a name's extension promises.
const PROMISED: &[(&str, &str)] = &[
    ("jpg", "jpeg"),
    ("jpeg", "jpeg"),
    ("jpe", "jpeg"),
    ("jfif", "jpeg"),
    ("png", "png"),
    ("gif", "gif"),
    ("pdf", "pdf"),
    ("zip", "zip"),
    ("docx", "office"),
    ("xlsx", "office"),
    ("pptx", "office"),
    ("odt", "office"),
    ("ods", "office"),
    ("odp", "office"),
    ("exe", "pe"),
    ("dll", "pe"),
    ("sys", "pe"),
    ("scr", "pe"),
    ("ocx", "pe"),
    ("cpl", "pe"),
    ("txt", "text"),
    ("log", "text"),
    ("csv", "text"),
    ("md", "text"),
    ("json", "text"),
    ("xml", "text"),
    ("html", "text"),
    ("htm", "text"),
    ("ini", "text"),
    ("pcap", "pcap"),
    ("cap", "pcap"),
    ("pcapng", "pcapng"),
    ("evtx", "evtx"),
    ("sqlite", "sqlite"),
    ("db", "sqlite"),
    ("gz", "gzip"),
    ("7z", "7z"),
    ("rar", "rar"),
    ("lnk", "lnk"),
];
/// Kinds that run when opened.
const RUNS_WHEN_OPENED: &[&str] = &["pe", "elf", "macho", "lnk"];

/// A capture saved as `.pcap` is often pcapng, and the other way round;
/// every capture tool opens both.
fn same_family(promised: &str, kind: &str) -> bool {
    promised == kind || matches!((promised, kind), ("pcap", "pcapng") | ("pcapng", "pcap"))
}

pub fn analyze(subject: &Subject, _budget: &Budget) -> io::Result<Report> {
    let head = head(subject.path, 4096)?;
    let kind = detect_kind(&head, subject.extension.as_deref());
    let magic = head
        .iter()
        .take(16)
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ");
    let mut facts = vec![
        Fact::new(Group::Summary, "identify.kind", kind),
        Fact::new(Group::Detail, "identify.magic", magic.clone()),
    ];
    let mut body = format!("Type by content: {kind}\nFirst bytes: {magic}\n");
    let extension = subject.extension.as_deref();
    let promised = extension.and_then(|ext| {
        PROMISED
            .iter()
            .find(|(known, _)| *known == ext)
            .map(|(_, kind)| *kind)
    });
    if let Some(ext) = extension {
        facts.push(Fact::new(Group::Detail, "identify.extension", ext));
        match promised {
            Some(promised) => {
                body.push_str(&format!("Extension: .{ext} (names a {promised} file)\n"))
            }
            None => body.push_str(&format!("Extension: .{ext}\n")),
        }
    }
    if let (Some(ext), Some(promised)) = (extension, promised) {
        if !same_family(promised, kind) {
            if RUNS_WHEN_OPENED.contains(&kind) && !RUNS_WHEN_OPENED.contains(&promised) {
                facts.push(
                    Fact::new(Group::Interesting, "identify.mismatch", ext)
                        .hint("disguisedExecutable"),
                );
                body.push_str("Note: a program named like another kind of file.\n");
            } else if !matches!(kind, "binary" | "text") {
                facts.push(
                    Fact::new(Group::Interesting, "identify.mismatch", ext)
                        .hint("extensionMismatch"),
                );
                body.push_str("Note: the extension does not match the content.\n");
            }
        }
    }
    Ok(Report {
        facts,
        body,
        limited: false,
    })
}

#[cfg(test)]
mod tests {
    use super::super::testing::{budget, sample, subject};
    use super::*;

    fn interesting(report: &Report) -> Vec<(&'static str, Option<&'static str>)> {
        report
            .facts
            .iter()
            .filter(|fact| fact.group == Group::Interesting)
            .map(|fact| (fact.key, fact.hint))
            .collect()
    }

    #[test]
    fn a_program_named_like_a_document_is_called_out() {
        let mut bytes = b"MZ".to_vec();
        bytes.extend_from_slice(&[0u8; 200]);
        let file = sample(&bytes);
        let report = analyze(&subject(&file, "pe", Some("pdf")), &budget()).unwrap();
        assert_eq!(report.facts[0].value, "pe");
        assert_eq!(
            interesting(&report),
            vec![("identify.mismatch", Some("disguisedExecutable"))]
        );
    }

    #[test]
    fn a_misnamed_picture_is_a_mismatch_and_a_true_name_is_not() {
        let png = sample(b"\x89PNG\r\n\x1A\n0000");
        let report = analyze(&subject(&png, "png", Some("jpg")), &budget()).unwrap();
        assert_eq!(
            interesting(&report),
            vec![("identify.mismatch", Some("extensionMismatch"))]
        );
        let report = analyze(&subject(&png, "png", Some("png")), &budget()).unwrap();
        assert!(interesting(&report).is_empty());
        // A name that promises nothing claims nothing.
        let report = analyze(&subject(&png, "png", None), &budget()).unwrap();
        assert!(interesting(&report).is_empty());
    }

    #[test]
    fn a_capture_in_the_other_capture_format_is_not_a_mismatch() {
        let pcapng = sample(b"\x0A\x0D\x0D\x0A\x1C\x00\x00\x00");
        let report = analyze(&subject(&pcapng, "pcapng", Some("pcap")), &budget()).unwrap();
        assert!(interesting(&report).is_empty());
    }
}
