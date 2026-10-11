//! Server-sent events (`text/event-stream`), the format the cloud services
//! stream answers in, read from raw bytes. An event is decoded only once it
//! is whole, so a UTF-8 letter split across two network reads stays whole.

use super::errors::AiError;

/// An event still arriving may not grow past this.
const MAX_PENDING_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// The `event:` field, when the service names one.
    pub event: Option<String>,
    /// Every `data:` line, joined with `\n`.
    pub data: String,
}

#[derive(Default)]
pub struct SseBuffer {
    pending: Vec<u8>,
}

impl SseBuffer {
    /// Add what arrived; returns the events it completed, in order.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>, AiError> {
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some((end, separator)) = blank_line(&self.pending) {
            let whole: Vec<u8> = self.pending.drain(..end + separator).collect();
            if let Some(event) = parse_event(&whole[..end]) {
                events.push(event);
            }
        }
        if self.pending.len() > MAX_PENDING_BYTES {
            return Err(AiError::Unexpected);
        }
        Ok(events)
    }
}

/// Where the first event ends: the newline before an empty line, and how
/// many bytes the separator takes (`\n\n` or `\n\r\n`).
fn blank_line(bytes: &[u8]) -> Option<(usize, usize)> {
    bytes.iter().enumerate().find_map(|(i, &byte)| {
        if byte != b'\n' {
            return None;
        }
        match (bytes.get(i + 1), bytes.get(i + 2)) {
            (Some(b'\n'), _) => Some((i, 2)),
            (Some(b'\r'), Some(b'\n')) => Some((i, 3)),
            _ => None,
        }
    })
}

fn parse_event(bytes: &[u8]) -> Option<SseEvent> {
    let text = String::from_utf8_lossy(bytes);
    let mut event = None;
    let mut data: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => event = Some(value.to_string()),
            "data" => data.push(value),
            _ => {}
        }
    }
    // An event without data is not dispatched (the SSE rules).
    (!data.is_empty()).then(|| SseEvent {
        event,
        data: data.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(name: Option<&str>, data: &str) -> SseEvent {
        SseEvent {
            event: name.map(str::to_string),
            data: data.into(),
        }
    }

    #[test]
    fn reads_named_events_one_or_more_at_a_time() {
        let mut buffer = SseBuffer::default();
        assert_eq!(
            buffer.push(b"event: ping\ndata: {}\n\n").unwrap(),
            vec![event(Some("ping"), "{}")]
        );
        assert_eq!(
            buffer
                .push(b"event: a\ndata: 1\n\nevent: b\ndata:2\n\n")
                .unwrap(),
            vec![event(Some("a"), "1"), event(Some("b"), "2")]
        );
    }

    #[test]
    fn a_letter_split_across_reads_stays_whole() {
        let mut buffer = SseBuffer::default();
        let whole = "data: ağaç\n\n".as_bytes();
        let cut = "data: a".len() + 1; // inside the two bytes of "ğ"
        assert!(buffer.push(&whole[..cut]).unwrap().is_empty());
        assert_eq!(
            buffer.push(&whole[cut..]).unwrap(),
            vec![event(None, "ağaç")]
        );
    }

    #[test]
    fn crlf_lines_multi_line_data_and_comments() {
        let mut buffer = SseBuffer::default();
        assert_eq!(
            buffer.push(b"event: a\r\ndata: x\r\n\r\n").unwrap(),
            vec![event(Some("a"), "x")]
        );
        assert_eq!(
            buffer.push(b"data: first\ndata: second\n\n").unwrap(),
            vec![event(None, "first\nsecond")]
        );
        assert!(buffer.push(b": keep-alive\n\n").unwrap().is_empty());
        assert_eq!(
            buffer.push(b": note\ndata: y\n\n").unwrap(),
            vec![event(None, "y")]
        );
    }

    #[test]
    fn an_event_that_never_ends_is_refused() {
        let mut buffer = SseBuffer::default();
        let chunk = vec![b'x'; 64 * 1024];
        let mut result = Ok(Vec::new());
        for _ in 0..17 {
            result = buffer.push(&chunk);
            if result.is_err() {
                break;
            }
        }
        assert_eq!(result, Err(AiError::Unexpected));
    }
}
