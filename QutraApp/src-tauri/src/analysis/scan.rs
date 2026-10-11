//! Reading a file within an analyzer's limits: at most `cap` bytes, and
//! only while its time lasts. A pass a limit cut short says so.

use std::{
    fs::File,
    io::{self, Read},
    path::Path,
    time::{Duration, Instant},
};

const CHUNK: usize = 1 << 20;

/// How much of a file an analyzer may read, and for how long.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    deadline: Instant,
    cap: u64,
}

impl Budget {
    pub fn new(time: Duration, cap: u64) -> Self {
        Self {
            deadline: Instant::now() + time,
            cap,
        }
    }

    pub fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }
}

/// What one pass over a file read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scanned {
    pub read: u64,
    pub size: u64,
}

impl Scanned {
    /// A limit stopped the pass before the end of the file.
    pub fn limited(&self) -> bool {
        self.read < self.size
    }
}

/// Hand the file to `each`, chunk by chunk with each chunk's offset, until
/// its end, the budget's cap or the budget's time.
pub fn each_chunk(
    path: &Path,
    budget: &Budget,
    mut each: impl FnMut(u64, &[u8]),
) -> io::Result<Scanned> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut buffer = vec![0u8; CHUNK];
    let mut read: u64 = 0;
    while read < size.min(budget.cap) && !budget.expired() {
        let want = (budget.cap - read).min(CHUNK as u64) as usize;
        let got = match file.read(&mut buffer[..want]) {
            Ok(0) => break,
            Ok(got) => got,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        each(read, &buffer[..got]);
        read += got as u64;
    }
    Ok(Scanned { read, size })
}

/// The first `len` bytes of the file (fewer when it is shorter).
pub fn head(path: &Path, len: usize) -> io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(len);
    File::open(path)?.take(len as u64).read_to_end(&mut head)?;
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pass_stops_at_the_cap_or_the_time_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        let size = 3 * CHUNK as u64 + 5;
        std::fs::write(&path, vec![7u8; size as usize]).unwrap();

        let mut seen = 0u64;
        let whole = each_chunk(
            &path,
            &Budget::new(Duration::from_secs(30), u64::MAX),
            |_, chunk| seen += chunk.len() as u64,
        )
        .unwrap();
        assert_eq!(
            (whole.read, whole.size, whole.limited()),
            (size, size, false)
        );
        assert_eq!(seen, size);

        let capped = each_chunk(
            &path,
            &Budget::new(Duration::from_secs(30), CHUNK as u64 + 10),
            |_, _| {},
        )
        .unwrap();
        assert_eq!(capped.read, CHUNK as u64 + 10);
        assert!(capped.limited());

        let late = each_chunk(&path, &Budget::new(Duration::ZERO, u64::MAX), |_, _| {}).unwrap();
        assert_eq!(late.read, 0);
        assert!(late.limited());
        assert_eq!(head(&path, 4).unwrap(), vec![7u8; 4]);
    }
}
