//! capinfos' `-M` long report as facts. capinfos reads packet
//! headers only, so no protocol dissector touches a hostile capture. The
//! capture's own comment is its author's text and stays out of the facts, as
//! ExifTool's comment tags do: it stays in the raw output, which is hashed. A
//! capture that breaks off still gets its report, but capinfos exits with 1 and
//! says why on standard error; that reason is a fact too.

use super::{stderr_error, ParseContext};
use crate::{
    analysis::{clean_text, Fact, Group},
    tool_supervisor::RunLogs,
};

/// A capture cut shorter than this lost its payloads.
const CUT_BELOW: u64 = 1500;

pub fn parse(logs: &RunLogs, ctx: &ParseContext) -> Result<Vec<Fact>, String> {
    let mut report: Vec<(String, String)> = Vec::new();
    let mut interfaces = 0_usize;
    for line in logs.stdout.lines() {
        // An interface's own details are indented under its heading.
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        if line.starts_with("Interface #") {
            interfaces += 1;
        } else if let Some((key, value)) = line.split_once(':') {
            report.push((key.trim().to_string(), value.trim().to_string()));
        }
    }
    let get = |key: &str| {
        report
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    let Some(packets) = get("Number of packets").and_then(first_number) else {
        // No report: capinfos said why on the other stream.
        return stderr_error("capinfos.error", &logs.stderr, ctx, lead_in).map(|error| vec![error]);
    };
    // A report with a failed run behind it: the capture broke off.
    let complaint = if logs.exit_code == Some(0) {
        None
    } else {
        stderr_error("capinfos.error", &logs.stderr, ctx, lead_in).ok()
    };
    let broken = complaint.is_some();
    // "n/a" is capinfos' way to say there is none.
    let text = |key: &str| {
        get(key)
            .map(clean_text)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("n/a"))
    };

    let mut facts = Vec::new();
    for (key, name) in [
        ("capinfos.type", "File type"),
        ("capinfos.encap", "File encapsulation"),
    ] {
        if let Some(value) = text(name) {
            facts.push(Fact::new(Group::Summary, key, value));
        }
    }
    facts.push(Fact::new(
        Group::Summary,
        "capinfos.packets",
        packets as u64,
    ));
    if let Some(seconds) = get("Capture duration").and_then(first_number) {
        facts.push(Fact::new(
            Group::Summary,
            "capinfos.duration",
            (seconds * 1000.0).round() / 1000.0,
        ));
    }
    for (key, name) in [
        ("capinfos.first", "Earliest packet time"),
        ("capinfos.last", "Latest packet time"),
    ] {
        if let Some(value) = text(name) {
            facts.push(Fact::new(Group::Summary, key, value));
        }
    }
    facts.extend(complaint);

    // A capture that broke off may have no packets because of it: that is
    // damage, not an empty capture.
    if packets == 0.0 && !broken {
        facts.push(Fact::new(Group::Interesting, "capinfos.empty", 0).hint("emptyCapture"));
    }
    // What the packets were cut to: the limit in the file header, or when the
    // header has none, the one length the cut packets show. capinfos prints a
    // line for each.
    let sizes: Vec<&str> = report
        .iter()
        .filter(|(name, _)| name == "Packet size limit")
        .map(|(_, value)| value.as_str())
        .collect();
    let declared = sizes
        .iter()
        .filter(|value| !value.starts_with("inferred:"))
        .find_map(|value| {
            value
                .split_whitespace()
                .find_map(|word| word.parse::<u64>().ok())
        });
    let cut = declared.or_else(|| sizes.iter().find_map(|value| inferred_length(value)));
    if let Some(limit) = cut.filter(|limit| *limit < CUT_BELOW) {
        facts.push(Fact::new(Group::Interesting, "capinfos.snaplen", limit).hint("snaplen"));
    }
    if get("Strict time order").is_some_and(|value| value.eq_ignore_ascii_case("false")) {
        facts.push(Fact::new(Group::Interesting, "capinfos.order", "no").hint("timeOrder"));
    }

    if let Some(size) = get("Data size").and_then(first_number) {
        facts.push(Fact::new(Group::Detail, "capinfos.dataSize", size as u64));
    }
    if let Some(app) = text("Capture application") {
        facts.push(Fact::new(Group::Detail, "capinfos.app", app));
    }
    if interfaces > 0 {
        facts.push(Fact::new(Group::Detail, "capinfos.interfaces", interfaces));
    }
    Ok(facts)
}

fn first_number(value: &str) -> Option<f64> {
    value.split_whitespace().next()?.parse().ok()
}

/// `inferred: 40 bytes`, the one length all the cut packets have. A range
/// (`inferred: 60 bytes - 80 bytes (range)`) is no limit.
fn inferred_length(value: &str) -> Option<u64> {
    value
        .strip_prefix("inferred:")?
        .trim()
        .strip_suffix("bytes")?
        .trim()
        .parse()
        .ok()
}

/// The first line capinfos prints when a capture breaks off. It says where;
/// the next one says why.
fn lead_in(line: &str) -> bool {
    line.contains("An error occurred after reading")
}

#[cfg(test)]
mod tests {
    use super::super::testing::{ctx, fact, killed, logs};
    use super::*;

    const REPORT: &str =
        "File name:           C:\\Users\\test\\Documents\\Qutra Labs\\case\\files\\dump.pcap\n\
File type:           Wireshark/tcpdump/... - pcap\n\
File encapsulation:  Ethernet\n\
Packet size limit:   file hdr: 96 bytes\n\
Number of packets:   1234\n\
File size:           567890 bytes\n\
Data size:           543210 bytes\n\
Capture duration:    12.3456789 seconds\n\
Earliest packet time: 2023-05-12 14:03:11.123456\n\
Latest packet time:  2023-05-12 14:03:23.469134\n\
Strict time order:   False\n\
Capture comment:     found on a share\n\
Number of interfaces in file: 1\n\
Interface #0 info:\n\
                     Name = eth0\n\
                     Capture length = 96\n";

    // Real capinfos 4.6.1 output on Windows (`-M`), only the file's path
    // changed. A capture whose second packet is cut short still gets its
    // report, then exit code 1 and three lines on standard error.
    const CUT_SHORT_REPORT: &[&str] = &[
        r"File name:           C:\Users\kullanici\Documents\Qutra Labs\vaka\files\kesik.pcap",
        r"File type:           pcap",
        r"File encapsulation:  ether",
        r"File timestamp precision:  microseconds (6)",
        r"Packet size limit:   file hdr: 262144 bytes",
        r"Number of packets:   1",
        r"File size:           136 bytes",
        r"Data size:           60 bytes",
        r"Capture duration:    0.000000 seconds",
        r"Earliest packet time: 1970-01-01 00:00:01.000002",
        r"Latest packet time:   1970-01-01 00:00:01.000002",
        r"Data byte rate:      n/a",
        r"Data bit rate:       n/a",
        r"Average packet size: 60.00 bytes",
        r"Average packet rate: n/a",
        r"SHA256:              72f068e1274525f50e8ac44458eafdc559fa3d367675b12b5a4655c88b9587e9",
        r"SHA1:                736db581687ca22362b0b97179db3fcd19f010b6",
        r"Strict time order:   True",
        r"Number of interfaces in file: 1",
        r"Interface #0 info:",
        r"                     Encapsulation = Ethernet (1 - ether)",
        r"                     Capture length = 262144",
        r"                     Time precision = microseconds (6)",
        r"                     Time ticks per second = 1000000",
        r"                     Number of stat entries = 0",
        r"                     Number of packets = 1",
    ];

    const CUT_SHORT_COMPLAINT: &[&str] = &[
        r#"capinfos: An error occurred after reading 1 packets from "C:\Users\kullanici\Documents\Qutra Labs\vaka\files\kesik.pcap"."#,
        r#"capinfos: The file "C:\Users\kullanici\Documents\Qutra Labs\vaka\files\kesik.pcap" appears to have been cut short in the middle of a packet."#,
        r"  (will continue anyway, checksums might be incorrect)",
    ];

    // The same for a capture cut inside its first packet: no packet at all.
    const CUT_FIRST_REPORT: &[&str] = &[
        r"File name:           C:\Users\kullanici\Documents\Qutra Labs\vaka\files\ilk-paket.pcap",
        r"File type:           pcap",
        r"File encapsulation:  ether",
        r"File timestamp precision:  microseconds (6)",
        r"Packet size limit:   file hdr: 262144 bytes",
        r"Number of packets:   0",
        r"File size:           60 bytes",
        r"Data size:           0 bytes",
        r"Capture duration:    n/a",
        r"Earliest packet time: n/a",
        r"Latest packet time:   n/a",
        r"Data byte rate:      n/a",
        r"Data bit rate:       n/a",
        r"Average packet size: 0.00 bytes",
        r"Average packet rate: n/a",
        r"SHA256:              34002f33834b59a38ddadeba1364157dd9257df8239d9c3bc751db28d016e7fe",
        r"SHA1:                1f466ac57e21efc8f340e31287ad1f4cba3ff1fa",
        r"Strict time order:   True",
        r"Number of interfaces in file: 1",
        r"Interface #0 info:",
        r"                     Encapsulation = Ethernet (1 - ether)",
        r"                     Capture length = 262144",
        r"                     Time precision = microseconds (6)",
        r"                     Time ticks per second = 1000000",
        r"                     Number of stat entries = 0",
        r"                     Number of packets = 0",
    ];

    const CUT_FIRST_COMPLAINT: &[&str] = &[
        r#"capinfos: An error occurred after reading 0 packets from "C:\Users\kullanici\Documents\Qutra Labs\vaka\files\ilk-paket.pcap"."#,
        r#"capinfos: The file "C:\Users\kullanici\Documents\Qutra Labs\vaka\files\ilk-paket.pcap" appears to have been cut short in the middle of a packet."#,
        r"  (will continue anyway, checksums might be incorrect)",
    ];

    /// Lines as capinfos ends them on Windows: with CR LF.
    fn crlf(lines: &[&str]) -> String {
        lines.iter().map(|line| format!("{line}\r\n")).collect()
    }

    fn in_vaka(name: &str) -> ParseContext {
        ParseContext {
            input_path: format!(r"C:\Users\kullanici\Documents\Qutra Labs\vaka\files\{name}"),
            input_name: name.into(),
            rules_path: None,
            rules_name: None,
        }
    }

    #[test]
    fn a_capture_s_summary_is_read_and_a_cut_one_stands_out() {
        let facts = parse(&logs(REPORT, "", 0), &ctx()).unwrap();
        let value = |key: &str| fact(&facts, key).map(|f| f.value.clone());
        assert_eq!(value("capinfos.packets"), Some(1234.into()));
        assert_eq!(value("capinfos.duration"), Some(12.346.into()));
        assert_eq!(
            value("capinfos.first"),
            Some("2023-05-12 14:03:11.123456".into())
        );
        assert_eq!(value("capinfos.encap"), Some("Ethernet".into()));
        let cut = fact(&facts, "capinfos.snaplen").unwrap();
        assert_eq!(
            (cut.group, cut.hint, cut.value.clone()),
            (Group::Interesting, Some("snaplen"), 96.into())
        );
        assert_eq!(
            fact(&facts, "capinfos.order").unwrap().hint,
            Some("timeOrder")
        );
        // The capture's comment is its author's own text: it stays in the raw
        // output, out of the facts.
        assert!(fact(&facts, "capinfos.comment").is_none());
        assert!(!format!("{facts:?}").contains("found on a share"));
        assert_eq!(value("capinfos.interfaces"), Some(1.into()));
        assert!(!format!("{facts:?}").contains("Users"));
    }

    #[test]
    fn an_empty_capture_is_flagged_and_a_file_that_is_not_one_is_an_error() {
        let empty = parse(&logs("Number of packets:   0\n", "", 0), &ctx()).unwrap();
        assert_eq!(
            fact(&empty, "capinfos.empty").unwrap().hint,
            Some("emptyCapture")
        );

        let facts = parse(
            &logs("", "capinfos: The file \"C:\\Users\\test\\Documents\\Qutra Labs\\case\\files\\photo.jpg\" isn't a capture file in a format Wireshark understands.\n", 2),
            &ctx(),
        )
        .unwrap();
        assert_eq!(
            facts[0].value,
            "capinfos: The file \"photo.jpg\" isn't a capture file in a format Wireshark understands."
        );
        assert_eq!(
            parse(&logs("", "", 2), &ctx()).err(),
            Some("output_unreadable".into())
        );
    }

    #[test]
    fn an_interface_s_details_are_not_the_capture_s_and_a_cut_report_never_panics() {
        // The details under "Interface #n" are indented, and a hostile
        // capture can put any text in them: none of it is read as the
        // capture's own.
        let report = [
            r"File name:           C:\Users\test\Documents\Qutra Labs\case\files\dump.pcapng",
            "Packet size limit:   file hdr: (not set)",
            "Number of packets:   4",
            "Capture duration:    0.012345 seconds",
            "Strict time order:   True",
            "Number of interfaces in file: 2",
            "Interface #0 info:",
            r"                     Name = \Device\NPF_{3F2A}",
            "                     Description = Wi-Fi: office",
            "                     Capture comment: injected",
            "                     Strict time order: False",
            "                     Number of packets: 999",
            "Interface #1 info:",
            "                     Name = lo",
        ]
        .join("\n")
            + "\n";
        let facts = parse(&logs(&report, "", 0), &ctx()).unwrap();
        let value = |key: &str| fact(&facts, key).map(|f| f.value.clone());
        assert_eq!(value("capinfos.packets"), Some(4.into()));
        assert_eq!(value("capinfos.duration"), Some(0.012.into()));
        assert_eq!(value("capinfos.interfaces"), Some(2.into()));
        for absent in ["capinfos.comment", "capinfos.order", "capinfos.snaplen"] {
            assert!(fact(&facts, absent).is_none(), "{absent}");
        }

        // A run stopped part-way, or output cut at its limit, still gives
        // facts or the one short reason, and never the user's folders.
        for end in (0..=report.len()).filter(|end| report.is_char_boundary(*end)) {
            for cut in [logs(&report[..end], "", 0), killed(&report[..end], "")] {
                match parse(&cut, &ctx()) {
                    Ok(facts) => {
                        assert!(!format!("{facts:?}").contains("Users"), "cut at byte {end}");
                    }
                    Err(code) => assert_eq!(code, "output_unreadable", "cut at byte {end}"),
                }
            }
        }
    }

    #[test]
    fn a_capture_cut_short_keeps_its_report_and_says_why() {
        let context = in_vaka("kesik.pcap");
        let (stdout, stderr) = (crlf(CUT_SHORT_REPORT), crlf(CUT_SHORT_COMPLAINT));
        let facts = parse(&logs(&stdout, &stderr, 1), &context).unwrap();
        let value = |key: &str| fact(&facts, key).map(|f| f.value.clone());
        // What the report says is kept...
        assert_eq!(value("capinfos.type"), Some("pcap".into()));
        assert_eq!(value("capinfos.encap"), Some("ether".into()));
        assert_eq!(value("capinfos.packets"), Some(1.into()));
        assert_eq!(
            value("capinfos.first"),
            Some("1970-01-01 00:00:01.000002".into())
        );
        assert_eq!(value("capinfos.interfaces"), Some(1.into()));
        // ...and so is why capinfos stopped: the line that says how, not the
        // one that only says where, and the file by its name.
        let error = fact(&facts, "capinfos.error").unwrap();
        assert_eq!(error.group, Group::Summary);
        assert_eq!(
            error.value,
            "capinfos: The file \"kesik.pcap\" appears to have been cut short in the middle of a packet."
        );
        assert!(!format!("{facts:?}").contains("Users"));

        // The same words after a run that exited cleanly are no error.
        let clean = parse(&logs(&stdout, &stderr, 0), &context).unwrap();
        assert!(fact(&clean, "capinfos.error").is_none());
    }

    #[test]
    fn a_capture_cut_inside_its_first_packet_is_not_an_empty_one() {
        let context = in_vaka("ilk-paket.pcap");
        let (stdout, stderr) = (crlf(CUT_FIRST_REPORT), crlf(CUT_FIRST_COMPLAINT));
        let facts = parse(&logs(&stdout, &stderr, 1), &context).unwrap();
        assert_eq!(fact(&facts, "capinfos.packets").unwrap().value, 0);
        assert!(fact(&facts, "capinfos.error").is_some());
        assert!(fact(&facts, "capinfos.empty").is_none());
        // "n/a" is no time and no length of time.
        for absent in ["capinfos.first", "capinfos.last", "capinfos.duration"] {
            assert!(fact(&facts, absent).is_none(), "{absent}");
        }
        // The rest of the report is kept.
        assert_eq!(fact(&facts, "capinfos.type").unwrap().value, "pcap");

        // The same report with nothing wrong is a capture with no packets.
        let empty = parse(&logs(&stdout, "", 0), &context).unwrap();
        assert_eq!(
            fact(&empty, "capinfos.empty").unwrap().hint,
            Some("emptyCapture")
        );
        assert!(fact(&empty, "capinfos.error").is_none());
    }

    #[test]
    fn a_limit_comes_from_the_header_or_from_one_length_but_never_from_a_range() {
        // The lines capinfos 4.6.1 prints about packet sizes: the limit in the
        // file header, if it has one, then what the cut packets show.
        let snaplen = |limits: &[&str]| {
            let mut lines = vec!["File type:           pcapng"];
            lines.extend_from_slice(limits);
            lines.push("Number of packets:   2");
            let facts = parse(&logs(&crlf(&lines), "", 0), &ctx()).unwrap();
            fact(&facts, "capinfos.snaplen").map(|f| f.value.clone())
        };
        // A limit in the header wins over what the packets show.
        assert_eq!(
            snaplen(&[
                "Packet size limit:   file hdr: 96 bytes",
                "Packet size limit:   inferred: 60 bytes"
            ]),
            Some(96.into())
        );
        // None there: the one length all the cut packets have is the limit.
        assert_eq!(
            snaplen(&[
                "Packet size limit:   file hdr: (not set)",
                "Packet size limit:   inferred: 40 bytes"
            ]),
            Some(40.into())
        );
        // A range of lengths is no limit.
        assert_eq!(
            snaplen(&[
                "Packet size limit:   file hdr: (not set)",
                "Packet size limit:   inferred: 60 bytes - 80 bytes (range)"
            ]),
            None
        );
        // Nothing cut: a large limit, none at all, or a length too long to
        // have cut a payload.
        assert_eq!(
            snaplen(&[
                "Packet size limit:   file hdr: 262144 bytes",
                "Packet size limit:   inferred: 60 bytes - 80 bytes (range)"
            ]),
            None
        );
        assert_eq!(snaplen(&["Packet size limit:   file hdr: (not set)"]), None);
        assert_eq!(
            snaplen(&[
                "Packet size limit:   file hdr: (not set)",
                "Packet size limit:   inferred: 1514 bytes"
            ]),
            None
        );
    }
}
