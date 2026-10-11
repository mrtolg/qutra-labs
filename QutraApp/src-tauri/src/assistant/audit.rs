//! Audit skeleton for assistant turns.
//!
//! Deliberately records *shape*, not content: request id, model, outcome and
//! durations. Prompts and answers are never written here.
//!
//! That is not an oversight to fix later. A transcript already lives in the
//! user's preferences where they can see and clear it; copying it into a second
//! store would create data the "clear chat" control does not actually clear,
//! which would make that control a lie. If content is ever added, the clear
//! action must wipe both, and retention must be documented first.

use std::sync::Mutex;

use serde::Serialize;

/// Bounded so a long session cannot grow memory without limit.
const MAX_ENTRIES: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub request_id: String,
    pub model: String,
    /// Stable outcome code — `completed`, `cancelled`, or an error code.
    pub outcome: String,
    pub duration_ms: u128,
    /// Count only. The text itself is intentionally absent.
    pub message_count: usize,
    /// Which allowlisted tool this entry is about, e.g. `terminal_run`.
    /// `None` for a turn-level entry that carries no single tool call.
    /// Never the command text or arguments — shape, not content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// What was decided about that tool call — `approved`, `rejected`,
    /// `auto_approved`, `timeout`, or `cancelled`. `None` for a turn-level
    /// entry. Never the model's stated rationale.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
}

#[derive(Default)]
pub struct AuditLog {
    entries: Mutex<Vec<AuditEntry>>,
}

impl AuditLog {
    pub fn record(&self, entry: AuditEntry) {
        let mut entries = match self.entries.lock() {
            Ok(guard) => guard,
            // A poisoned lock must not take the assistant down with it; audit
            // is observability, never a precondition for answering.
            Err(poisoned) => poisoned.into_inner(),
        };
        entries.push(entry);
        if entries.len() > MAX_ENTRIES {
            let excess = entries.len() - MAX_ENTRIES;
            entries.drain(0..excess);
        }
    }

    #[cfg(test)]
    pub fn entries(&self) -> Vec<AuditEntry> {
        match self.entries.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> AuditEntry {
        AuditEntry {
            request_id: id.into(),
            model: "test-model".into(),
            outcome: "completed".into(),
            duration_ms: 1,
            message_count: 2,
            tool: None,
            decision: None,
        }
    }

    #[test]
    fn records_outcomes_without_content() {
        let log = AuditLog::default();
        log.record(entry("r1"));

        let entries = log.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].request_id, "r1");
        // The struct has nowhere to put a prompt, which is the point.
        let json = serde_json::to_string(&entries[0]).unwrap();
        assert!(!json.contains("content"), "{json}");
    }

    #[test]
    fn a_tool_entry_records_the_decision_but_never_the_command() {
        let log = AuditLog::default();
        log.record(AuditEntry {
            request_id: "r1".into(),
            model: "m".into(),
            outcome: "completed".into(),
            duration_ms: 1,
            message_count: 2,
            tool: Some("terminal_run".into()),
            decision: Some("approved".into()),
        });
        let json = serde_json::to_string(&log.entries()[0]).unwrap();
        assert!(json.contains("terminal_run"));
        assert!(json.contains("approved"));
        // The command text is not in the struct, which is the point.
        assert!(!json.contains("whoami"), "{json}");
    }

    #[test]
    fn is_bounded_and_drops_oldest_first() {
        let log = AuditLog::default();
        for i in 0..(MAX_ENTRIES + 10) {
            log.record(entry(&format!("r{i}")));
        }
        let entries = log.entries();
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].request_id, "r10");
    }
}
