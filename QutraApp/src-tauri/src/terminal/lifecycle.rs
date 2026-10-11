//! Native session facts and lifecycle (data contracts §1).
//!
//! Rust owns a session's identity, its startup facts and the end of its
//! process; the renderer only displays them. Two facts are kept apart on
//! purpose: the shell *process* ending, established by waiting on the child,
//! and the *output stream* closing, established by the reader seeing EOF. A
//! shell can exit while a grandchild still holds the PTY open, and the stream
//! can close while the process lingers, so neither stands in for the other.
//!
//! There is no shell integration here: the working directory reported is the
//! one the process was started in, never the shell's current one, and the
//! exit code is the shell process's, never the last command's.
//!
//! Every change bumps one registry-wide revision under one lock and is handed
//! to the sink while that lock is held, so events leave in revision order and
//! a `list` snapshot taken under the same lock covers exactly the changes up
//! to its revision. A renderer subscribes, then lists, then applies only
//! events newer than the list.

use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Who asked for a session. Set by the Rust route that opened it, never
/// supplied by the renderer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionOrigin {
    /// A shell tab the user opened.
    User,
    /// A shell the assistant opened for an approved `terminal_run`.
    Assistant,
    /// A registered installation resolved through the identity gate.
    RegisteredTool { installation_id: String },
}

impl SessionOrigin {
    fn as_wire(&self) -> &'static str {
        match self {
            SessionOrigin::User => "user",
            SessionOrigin::Assistant => "assistant",
            SessionOrigin::RegisteredTool { .. } => "registered_tool",
        }
    }

    fn installation_id(&self) -> Option<String> {
        match self {
            SessionOrigin::RegisteredTool { installation_id } => Some(installation_id.clone()),
            _ => None,
        }
    }
}

/// The shell process, as far as Rust knows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    Running,
    /// Close was asked for and the kill sent; the exit has not been seen yet.
    Stopping,
    Exited,
    /// Waiting on the child failed, so whether it still runs is not known.
    Unknown,
}

/// The PTY output stream, independent of the process.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IoState {
    Open,
    Closed,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    /// The process ended without this app asking it to.
    Natural,
    /// The process ended after a close or stop-all from this app.
    Stopped,
}

/// Where `initial_cwd` came from. Only `spawn` exists under option A: the
/// directory handed to the process when it started, never a directory the
/// shell later reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CwdSource {
    Spawn,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExit {
    /// The shell process's exit code, not the last command's.
    pub code: u32,
    pub reason: ExitReason,
    /// Unix epoch milliseconds.
    pub ended_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub runtime_id: String,
    pub session_id: String,
    /// Registry revision of this session's latest change.
    pub revision: u64,
    pub origin: &'static str,
    pub installation_id: Option<String>,
    pub state: ProcessState,
    pub io_state: IoState,
    pub pid: Option<u32>,
    /// File name of the program spawned, never its full path.
    pub program_name: String,
    /// Unix epoch milliseconds.
    pub started_at: u64,
    /// Measured by Rust on a monotonic clock as of this snapshot; frozen once
    /// the process has exited.
    pub elapsed_ms: u64,
    pub initial_cwd: Option<String>,
    pub cwd_source: CwdSource,
    pub exit: Option<SessionExit>,
}

/// Payload of `terminal://session`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionEvent {
    pub runtime_id: String,
    pub revision: u64,
    pub session: TerminalSessionInfo,
}

/// Response to `terminal_list_sessions`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionList {
    pub runtime_id: String,
    pub revision: u64,
    pub sessions: Vec<TerminalSessionInfo>,
}

pub type SessionSink = Arc<dyn Fn(&TerminalSessionEvent) + Send + Sync>;

/// Facts fixed when the process starts.
pub(super) struct SessionFacts {
    pub session_id: String,
    pub origin: SessionOrigin,
    pub pid: Option<u32>,
    pub program_name: String,
    pub started_at_ms: u64,
    pub started: Instant,
    pub initial_cwd: Option<String>,
}

/// Facts that change. Only ever mutated inside `Clock::change`.
pub(super) struct Life {
    state: ProcessState,
    io: IoState,
    exit: Option<SessionExit>,
    stop_requested: bool,
    ended: Option<Instant>,
    revision: u64,
}

pub(super) struct SessionRecord {
    facts: SessionFacts,
    life: Mutex<Life>,
}

impl SessionRecord {
    pub fn new(facts: SessionFacts) -> Self {
        SessionRecord {
            facts,
            life: Mutex::new(Life {
                state: ProcessState::Running,
                io: IoState::Open,
                exit: None,
                stop_requested: false,
                ended: None,
                revision: 0,
            }),
        }
    }

    /// Asked to stop, and no exit seen yet.
    pub fn is_stopping(&self) -> bool {
        self.life.lock().unwrap().state == ProcessState::Stopping
    }

    fn info(&self, runtime_id: &str, life: &Life, now: Instant) -> TerminalSessionInfo {
        let until = life.ended.unwrap_or(now);
        TerminalSessionInfo {
            runtime_id: runtime_id.to_string(),
            session_id: self.facts.session_id.clone(),
            revision: life.revision,
            origin: self.facts.origin.as_wire(),
            installation_id: self.facts.origin.installation_id(),
            state: life.state,
            io_state: life.io,
            pid: self.facts.pid,
            program_name: self.facts.program_name.clone(),
            started_at: self.facts.started_at_ms,
            elapsed_ms: until
                .saturating_duration_since(self.facts.started)
                .as_millis() as u64,
            initial_cwd: self.facts.initial_cwd.clone(),
            cwd_source: if self.facts.initial_cwd.is_some() {
                CwdSource::Spawn
            } else {
                CwdSource::Unknown
            },
            exit: life.exit.clone(),
        }
    }
}

/// Mark that this app asked the process to stop. Returns whether anything
/// changed: a process that already ended keeps its natural exit.
pub(super) fn request_stop(life: &mut Life) -> bool {
    if life.state != ProcessState::Running {
        return false;
    }
    life.state = ProcessState::Stopping;
    life.stop_requested = true;
    true
}

/// The kill sent after `request_stop` was refused. A process still marked
/// stopping did not end: it is running again and nothing is asking it to
/// stop, so a later exit reads as natural. One whose exit was already
/// recorded keeps it.
pub(super) fn stop_refused(life: &mut Life) -> bool {
    if life.state != ProcessState::Stopping {
        return false;
    }
    life.state = ProcessState::Running;
    life.stop_requested = false;
    true
}

/// Record the result of waiting on the child: its exit code, or `None` when
/// the wait itself failed.
pub(super) fn record_exit(life: &mut Life, waited: Option<u32>, ended_at_ms: u64) -> bool {
    match waited {
        Some(code) => {
            life.state = ProcessState::Exited;
            life.ended = Some(Instant::now());
            life.exit = Some(SessionExit {
                code,
                reason: if life.stop_requested {
                    ExitReason::Stopped
                } else {
                    ExitReason::Natural
                },
                ended_at: ended_at_ms,
            });
        }
        None => life.state = ProcessState::Unknown,
    }
    true
}

/// Record that the reader left its loop: `clean` on EOF, not on a read error.
pub(super) fn record_stream_end(life: &mut Life, clean: bool) -> bool {
    life.io = if clean {
        IoState::Closed
    } else {
        IoState::Error
    };
    true
}

/// The registry-wide revision and the sink every change is handed to.
pub(super) struct Clock {
    runtime_id: String,
    revision: Mutex<u64>,
    sink: SessionSink,
}

impl Clock {
    pub fn new(sink: SessionSink) -> Self {
        Clock {
            runtime_id: uuid::Uuid::new_v4().to_string(),
            revision: Mutex::new(0),
            sink,
        }
    }

    /// Apply `f` to the session's changing facts. When it reports a change,
    /// bump the revision, emit the new snapshot and return it -- all under
    /// the revision lock, so no later revision can be emitted first.
    pub fn change(
        &self,
        record: &SessionRecord,
        f: impl FnOnce(&mut Life) -> bool,
    ) -> Option<TerminalSessionInfo> {
        let mut revision = self.revision.lock().unwrap();
        let mut life = record.life.lock().unwrap();
        if !f(&mut life) {
            return None;
        }
        *revision += 1;
        life.revision = *revision;
        let info = record.info(&self.runtime_id, &life, Instant::now());
        drop(life);
        (self.sink)(&TerminalSessionEvent {
            runtime_id: self.runtime_id.clone(),
            revision: *revision,
            session: info.clone(),
        });
        Some(info)
    }

    pub fn snapshot<'a>(
        &self,
        records: impl Iterator<Item = &'a Arc<SessionRecord>>,
    ) -> TerminalSessionList {
        let revision = self.revision.lock().unwrap();
        let now = Instant::now();
        let mut sessions: Vec<TerminalSessionInfo> = records
            .map(|r| r.info(&self.runtime_id, &r.life.lock().unwrap(), now))
            .collect();
        sessions.sort_by(|a, b| (a.started_at, &a.session_id).cmp(&(b.started_at, &b.session_id)));
        TerminalSessionList {
            runtime_id: self.runtime_id.clone(),
            revision: *revision,
            sessions,
        }
    }
}

pub(super) fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pure logic -- no PTY, so these run on every platform.
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn record(origin: SessionOrigin, cwd: Option<&str>) -> SessionRecord {
        SessionRecord::new(SessionFacts {
            session_id: "4f1c9a2e-0b7d-4e8a-9c3f-5d6e7f809a1b".into(),
            origin,
            pid: Some(18_432),
            program_name: "pwsh.exe".into(),
            started_at_ms: 1_727_800_000_000,
            started: Instant::now() - Duration::from_millis(1_500),
            initial_cwd: cwd.map(str::to_owned),
        })
    }

    fn collecting_clock() -> (Clock, Arc<Mutex<Vec<TerminalSessionEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let clock = Clock::new(Arc::new(move |e: &TerminalSessionEvent| {
            sink_events.lock().unwrap().push(e.clone())
        }));
        (clock, events)
    }

    #[test]
    fn info_serializes_with_the_contract_field_names_and_wire_values() {
        let (clock, _) = collecting_clock();
        let rec = record(
            SessionOrigin::RegisteredTool {
                installation_id: "8c0e5f3a-1d2b-4c6e-a7f8-9b0c1d2e3f4a".into(),
            },
            Some(r"C:\Users\Analyst\Engagements\acme"),
        );
        let info = clock.change(&rec, |_| true).unwrap();
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["origin"], "registered_tool");
        assert_eq!(
            json["installationId"],
            "8c0e5f3a-1d2b-4c6e-a7f8-9b0c1d2e3f4a"
        );
        assert_eq!(json["state"], "running");
        assert_eq!(json["ioState"], "open");
        assert_eq!(json["cwdSource"], "spawn");
        assert_eq!(json["initialCwd"], r"C:\Users\Analyst\Engagements\acme");
        assert_eq!(json["pid"], 18_432);
        assert_eq!(json["programName"], "pwsh.exe");
        assert_eq!(json["startedAt"], 1_727_800_000_000u64);
        assert!(json["exit"].is_null());
        assert!(json["elapsedMs"].as_u64().unwrap() >= 1_500);
        // Option A carries no shell telemetry: no field may suggest otherwise.
        assert!(json.get("reportedCwd").is_none());
        assert!(json.get("programVersion").is_none());
    }

    #[test]
    fn a_session_started_without_a_directory_says_its_source_is_unknown() {
        let (clock, _) = collecting_clock();
        let info = clock
            .change(&record(SessionOrigin::User, None), |_| true)
            .unwrap();
        assert_eq!(info.cwd_source, CwdSource::Unknown);
        assert_eq!(info.initial_cwd, None);
        assert_eq!(info.origin, "user");
        assert_eq!(info.installation_id, None);
    }

    #[test]
    fn every_change_bumps_one_registry_revision_and_is_emitted_in_order() {
        let (clock, events) = collecting_clock();
        let a = record(SessionOrigin::User, None);
        let b = record(SessionOrigin::Assistant, None);
        clock.change(&a, |_| true);
        clock.change(&b, |_| true);
        clock.change(&a, |l| record_exit(l, Some(0), 1));

        let revisions: Vec<u64> = events.lock().unwrap().iter().map(|e| e.revision).collect();
        assert_eq!(revisions, vec![1, 2, 3]);
        let last = events.lock().unwrap().last().unwrap().clone();
        assert_eq!(last.session.revision, 3);
        assert_eq!(last.runtime_id, last.session.runtime_id);
    }

    #[test]
    fn a_change_that_alters_nothing_emits_nothing() {
        let (clock, events) = collecting_clock();
        let rec = record(SessionOrigin::User, None);
        clock.change(&rec, |l| record_exit(l, Some(0), 1));
        assert!(clock.change(&rec, request_stop).is_none());
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[test]
    fn exit_without_a_stop_request_is_natural_and_freezes_elapsed_time() {
        let (clock, _) = collecting_clock();
        let rec = record(SessionOrigin::User, None);
        let info = clock
            .change(&rec, |l| record_exit(l, Some(3), 1_727_800_002_000))
            .unwrap();
        assert_eq!(info.state, ProcessState::Exited);
        assert_eq!(
            info.exit,
            Some(SessionExit {
                code: 3,
                reason: ExitReason::Natural,
                ended_at: 1_727_800_002_000,
            })
        );
        std::thread::sleep(Duration::from_millis(30));
        let later = clock.snapshot([Arc::new(rec)].iter()).sessions[0].elapsed_ms;
        assert_eq!(later, info.elapsed_ms, "elapsed time must stop at exit");
    }

    #[test]
    fn exit_after_a_stop_request_is_reported_as_stopped() {
        let (clock, _) = collecting_clock();
        let rec = record(SessionOrigin::User, None);
        let stopping = clock.change(&rec, request_stop).unwrap();
        assert_eq!(stopping.state, ProcessState::Stopping);
        let exited = clock.change(&rec, |l| record_exit(l, Some(1), 2)).unwrap();
        assert_eq!(exited.exit.unwrap().reason, ExitReason::Stopped);
    }

    #[test]
    fn a_refused_stop_leaves_the_process_running_and_not_asked_to_stop() {
        let (clock, events) = collecting_clock();
        let rec = record(SessionOrigin::User, None);
        clock.change(&rec, request_stop).unwrap();

        let refused = clock
            .change(&rec, stop_refused)
            .expect("a change is reported");
        assert_eq!(refused.state, ProcessState::Running);
        assert_eq!(
            events.lock().unwrap().last().unwrap().session.state,
            ProcessState::Running
        );
        // A later natural end is not reported as one this app caused.
        let exited = clock.change(&rec, |l| record_exit(l, Some(0), 3)).unwrap();
        assert_eq!(exited.exit.unwrap().reason, ExitReason::Natural);
    }

    #[test]
    fn a_refused_stop_after_the_exit_was_seen_changes_nothing() {
        let (clock, _) = collecting_clock();
        let rec = record(SessionOrigin::User, None);
        clock.change(&rec, request_stop).unwrap();
        clock.change(&rec, |l| record_exit(l, Some(1), 2)).unwrap();

        assert!(clock.change(&rec, stop_refused).is_none());
        let info = clock.snapshot([Arc::new(rec)].iter()).sessions.remove(0);
        assert_eq!(info.state, ProcessState::Exited);
    }

    #[test]
    fn a_failed_wait_is_unknown_rather_than_a_guessed_exit() {
        let (clock, _) = collecting_clock();
        let rec = record(SessionOrigin::User, None);
        let info = clock.change(&rec, |l| record_exit(l, None, 2)).unwrap();
        assert_eq!(info.state, ProcessState::Unknown);
        assert_eq!(info.exit, None);
    }

    #[test]
    fn stream_end_changes_io_state_but_not_process_state() {
        let (clock, _) = collecting_clock();
        let rec = record(SessionOrigin::User, None);
        let closed = clock.change(&rec, |l| record_stream_end(l, true)).unwrap();
        assert_eq!(closed.io_state, IoState::Closed);
        assert_eq!(closed.state, ProcessState::Running);
        let rec2 = record(SessionOrigin::User, None);
        let errored = clock
            .change(&rec2, |l| record_stream_end(l, false))
            .unwrap();
        assert_eq!(errored.io_state, IoState::Error);
    }

    #[test]
    fn snapshot_revision_covers_every_change_already_emitted() {
        let (clock, events) = collecting_clock();
        let rec = Arc::new(record(SessionOrigin::User, None));
        clock.change(&rec, |_| true);
        clock.change(&rec, request_stop);
        let list = clock.snapshot([rec.clone()].iter());
        let newest = events.lock().unwrap().last().unwrap().revision;
        assert_eq!(list.revision, newest);
        assert_eq!(list.sessions[0].state, ProcessState::Stopping);
        assert_eq!(list.runtime_id, events.lock().unwrap()[0].runtime_id);
    }
}
