//! How random the bytes are (§6.2 "entropy"), over the whole file and in up
//! to 64 blocks. Close to 8 bits per byte means compressed, encrypted or
//! packed; in a format that is compressed anyway that is expected.

use std::io;

use super::{
    scan::{each_chunk, Budget},
    Fact, Group, Report, Subject,
};

const EXPECTED_HIGH: &[&str] = &[
    "jpeg", "png", "gif", "zip", "office", "gzip", "7z", "rar", "pdf",
];
const HIGH: f64 = 7.2;
const BLOCKS: u64 = 64;
const MIN_BLOCK: u64 = 4096;

pub fn analyze(subject: &Subject, budget: &Budget) -> io::Result<Report> {
    let size = std::fs::metadata(subject.path)?.len();
    let block = size.div_ceil(BLOCKS).max(MIN_BLOCK);
    let mut total = [0u64; 256];
    let mut current = [0u64; 256];
    let mut filled = 0u64;
    let mut block_start = 0u64;
    let mut blocks: Vec<(u64, f64)> = Vec::new();
    let scanned = each_chunk(subject.path, budget, |offset, chunk| {
        let mut at = offset;
        let mut rest = chunk;
        while !rest.is_empty() {
            let take = ((block - filled) as usize).min(rest.len());
            for &byte in &rest[..take] {
                total[byte as usize] += 1;
                current[byte as usize] += 1;
            }
            filled += take as u64;
            at += take as u64;
            rest = &rest[take..];
            if filled == block {
                blocks.push((block_start, shannon(&current, filled)));
                current = [0; 256];
                filled = 0;
                block_start = at;
            }
        }
    })?;
    if filled > 0 {
        blocks.push((block_start, shannon(&current, filled)));
    }
    let entropy = round2(shannon(&total, scanned.read));
    let highest = round2(blocks.iter().map(|(_, e)| *e).fold(0.0, f64::max));
    let mut facts = vec![
        Fact::new(Group::Summary, "entropy.file", entropy),
        Fact::new(Group::Detail, "entropy.max", highest),
    ];
    if entropy >= HIGH && !EXPECTED_HIGH.contains(&subject.kind) {
        facts.push(Fact::new(Group::Interesting, "entropy.high", entropy).hint("packed"));
    }
    let mut body = format!(
        "Entropy: {entropy:.2} bits per byte over {} bytes (0 = one repeated byte, 8 = random)\nBlocks of {block} bytes:\n",
        scanned.read
    );
    for (start, value) in &blocks {
        let bar = "#".repeat((value / 8.0 * 32.0).round() as usize);
        body.push_str(&format!("0x{start:08X}  {value:.2}  {bar}\n"));
    }
    Ok(Report {
        facts,
        body,
        limited: scanned.limited(),
    })
}

/// The entropy of bytes already in memory (a PE section).
pub(crate) fn of(bytes: &[u8]) -> f64 {
    let mut counts = [0u64; 256];
    for &byte in bytes {
        counts[byte as usize] += 1;
    }
    round2(shannon(&counts, bytes.len() as u64))
}

fn shannon(counts: &[u64; 256], total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    let n = total as f64;
    // `abs` turns the -0.0 of a single repeated byte into 0.0.
    counts
        .iter()
        .filter(|&&c| c > 0)
        .map(|&c| {
            let p = c as f64 / n;
            -p * p.log2()
        })
        .sum::<f64>()
        .abs()
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::super::testing::{budget, sample, subject};
    use super::*;

    fn every_byte(times: usize) -> Vec<u8> {
        (0..times).flat_map(|_| 0u8..=255).collect()
    }

    #[test]
    fn one_repeated_byte_is_zero_and_every_byte_alike_is_eight() {
        let zeros = sample(&[0u8; 10_000]);
        let report = analyze(&subject(&zeros, "binary", None), &budget()).unwrap();
        assert_eq!(report.facts[0].value, 0.0);
        assert!(report.facts[0].value.as_f64().unwrap().is_sign_positive());
        let flat = sample(&every_byte(64));
        let report = analyze(&subject(&flat, "binary", None), &budget()).unwrap();
        assert_eq!(report.facts[0].value, 8.0);
        assert!(report.body.contains("0x00000000  8.00"));
    }

    #[test]
    fn high_entropy_stands_out_only_where_it_is_not_expected() {
        let flat = sample(&every_byte(64));
        let high = |kind: &str| {
            analyze(&subject(&flat, kind, None), &budget())
                .unwrap()
                .facts
                .iter()
                .any(|fact| fact.group == Group::Interesting && fact.hint == Some("packed"))
        };
        assert!(high("pe"));
        assert!(!high("zip"));
        assert!(!high("jpeg"));
    }
}
