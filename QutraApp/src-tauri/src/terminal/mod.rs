//! Interactive PTY terminal sessions.
//!
//! Shells are launched as an argument vector through portable-pty's
//! CommandBuilder — never a concatenated shell string (see trust-boundary
//! rules in lib.rs). Each session owns a reader thread that forwards raw
//! bytes to a caller-provided sink; the command layer turns that sink into a
//! `terminal://data` event. Closing a session drops its writer and kills the
//! child, so no shell is ever orphaned by the UI. A second thread per session
//! waits on the child and records how it ended (`lifecycle`), which the
//! command layer turns into a `terminal://session` event.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

pub mod commands;
pub mod lifecycle;

use lifecycle::{
    now_epoch_ms, record_exit, record_stream_end, request_stop, stop_refused, Clock, SessionFacts,
    SessionOrigin, SessionRecord, SessionSink, TerminalSessionInfo, TerminalSessionList,
};

/// Bound, in bytes, on how much decoded output one session buffers
/// server-side for replay (an agent-opened `terminal_run` session's
/// bytes are otherwise gone forever if no `TerminalTab` was mounted to
/// receive them live -- see `commands.rs`'s module doc and
/// `wireFromId` in `src/features/terminal/useTerminalSession.ts`, which
/// fetches this buffer before subscribing live). 256 KiB is on the same
/// order as a few thousand lines of typical shell text -- enough to hand a
/// tab that attaches late a genuinely useful backlog -- while keeping
/// worst-case memory bounded no matter how long a session lives or how much
/// it prints, the same instinct behind `AuditLog`'s 200-entry cap
/// (`assistant/audit.rs`) and `READ_CONTEXT_CHAR_LIMIT`
/// (`assistant/tools.rs`): bounded, never unlimited. Oldest bytes are
/// dropped first once the cap is hit -- this is a replay aid, not a durable
/// transcript. Output beyond the cap is simply gone, exactly like scrollback
/// that has scrolled off a real terminal's history; this module never claims
/// otherwise.
pub const SCROLLBACK_CAP_BYTES: usize = 256 * 1024;

/// Per-session buffer of decoded output, appended to by the reader thread and
/// read by `TerminalSessions::scrollback` for replay. Held behind its own
/// `Mutex`, separate from the sessions map, so appending output on one
/// session's reader thread never contends with open/write/close traffic on
/// another.
///
/// `total_bytes` is an uncapped, monotonically increasing count of every
/// byte this session has ever produced -- never trimmed, unlike `buf`. It
/// exists purely so a client can tell "already in the snapshot I just
/// fetched" apart from "arrived after it": each `terminal://data` event
/// carries the cumulative count as of that chunk (`seq`), and
/// `TerminalSessions::scrollback` returns the same counter's current value
/// (`cursor`) alongside the buffered text, so a caller can drop any live
/// event with `seq <= cursor` as already covered by the snapshot instead of
/// replaying it twice. See `wireFromId`'s handover logic on the TS side for
/// the consumer of this.
#[derive(Default)]
struct Scrollback {
    buf: String,
    total_bytes: u64,
}

impl Scrollback {
    /// Append `chunk` (already-decoded, valid-UTF-8 text) and return the new
    /// `total_bytes` value -- the `seq` the caller should emit alongside this
    /// chunk.
    fn push(&mut self, chunk: &str) -> u64 {
        self.buf.push_str(chunk);
        self.total_bytes += chunk.len() as u64;
        if self.buf.len() > SCROLLBACK_CAP_BYTES {
            let excess = self.buf.len() - SCROLLBACK_CAP_BYTES;
            // Drop oldest bytes, but only up to the next UTF-8 char boundary
            // at or after `excess`. `buf` holds valid UTF-8 built entirely
            // from already-decoded chunks, so cutting mid-character would
            // corrupt whatever character straddles the cut; scanning forward
            // to a boundary costs at most 3 extra bytes checked.
            let mut cut = excess;
            while cut < self.buf.len() && !self.buf.is_char_boundary(cut) {
                cut += 1;
            }
            self.buf.drain(..cut);
        }
        self.total_bytes
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellKind {
    Pwsh,
    PowerShell,
    Bash,
    /// Only reached through the Windows fallback chain — never a renderer choice.
    Cmd,
}

impl ShellKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            ShellKind::Pwsh => "pwsh",
            ShellKind::PowerShell => "powershell",
            ShellKind::Bash => "bash",
            ShellKind::Cmd => "cmd",
        }
    }
}

/// What the resolution chain actually picked. `program` is what we spawn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedShell {
    pub kind: ShellKind,
    pub program: String,
}

impl ResolvedShell {
    fn command(&self) -> CommandBuilder {
        CommandBuilder::new(&self.program)
    }
}

/// Walk PATH for `name`. Tests inject a lookup instead of calling this.
pub fn executable_on_path(name: &str) -> bool {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
}

/// pwsh.exe → powershell.exe → %COMSPEC%. bash is never a fallback member.
pub fn resolve_shell(
    requested: ShellKind,
    exists: impl Fn(&str) -> bool,
    comspec: Option<&str>,
) -> Result<ResolvedShell, String> {
    if requested == ShellKind::Bash {
        for name in ["bash.exe", "bash"] {
            if exists(name) {
                return Ok(ResolvedShell {
                    kind: ShellKind::Bash,
                    program: name.to_string(),
                });
            }
        }
        return Err("shell_not_found:bash".into());
    }

    let candidates: &[&str] = match requested {
        ShellKind::Pwsh => &["pwsh.exe", "powershell.exe"],
        ShellKind::PowerShell => &["powershell.exe"],
        ShellKind::Cmd => &[],
        ShellKind::Bash => unreachable!("bash returns above"),
    };
    for name in candidates {
        if exists(name) {
            let kind = if *name == "pwsh.exe" {
                ShellKind::Pwsh
            } else {
                ShellKind::PowerShell
            };
            return Ok(ResolvedShell {
                kind,
                program: (*name).to_string(),
            });
        }
    }

    let program = match comspec {
        Some(path) if !path.is_empty() => path.to_string(),
        _ if exists("cmd.exe") => "cmd.exe".to_string(),
        _ => return Err("shell_not_found:comspec".into()),
    };
    Ok(ResolvedShell {
        kind: ShellKind::Cmd,
        program,
    })
}

fn resolve_requested_shell(requested: ShellKind) -> Result<ResolvedShell, String> {
    resolve_shell(
        requested,
        executable_on_path,
        std::env::var("COMSPEC").ok().as_deref(),
    )
}

#[derive(Debug)]
pub enum SpawnTarget {
    Shell(ShellKind),
    /// A specific executable, spawned as an argv (never a shell string). The
    /// caller (command layer) must validate `program` before constructing this.
    Program {
        program: String,
        args: Vec<String>,
    },
}

#[derive(Debug)]
pub struct SpawnConfig {
    pub target: SpawnTarget,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Set by the Rust route that opens the session, never by the renderer.
    pub origin: SessionOrigin,
}

/// The directory the PTY layer would fall back to when given none: the
/// user's profile on Windows, home elsewhere. Resolved here and handed over
/// explicitly so the session can report where it started instead of
/// guessing what the library chose.
fn default_spawn_dir() -> Option<String> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(var)
        .ok()
        .filter(|dir| std::path::Path::new(dir).is_dir())
}

fn program_file_name(program: &str) -> String {
    std::path::Path::new(program)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.to_string())
}

/// Stateful, pure UTF-8 re-assembler for byte streams read in fixed-size
/// chunks (e.g. PTY reads). A multi-byte character can straddle two reads;
/// naive `from_utf8_lossy` per-chunk would turn the split character into
/// U+FFFD replacement characters. `push` buffers any incomplete trailing
/// sequence and returns it once it completes, so callers only ever see
/// well-formed text. Genuinely invalid (not merely incomplete) byte
/// sequences are still replaced with U+FFFD, exactly as `from_utf8_lossy`
/// would, so a malformed byte can never wedge the stream.
#[derive(Default)]
struct Utf8Chunker {
    buf: Vec<u8>,
}

impl Utf8Chunker {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.buf.extend_from_slice(bytes);
        let mut out = String::new();

        loop {
            if self.buf.is_empty() {
                break;
            }
            match std::str::from_utf8(&self.buf) {
                Ok(s) => {
                    out.push_str(s);
                    self.buf.clear();
                    break;
                }
                Err(e) => {
                    let valid_up_to = e.valid_up_to();
                    if valid_up_to > 0 {
                        out.push_str(
                            std::str::from_utf8(&self.buf[..valid_up_to])
                                .expect("valid_up_to bounds a valid prefix"),
                        );
                    }
                    match e.error_len() {
                        // Genuinely invalid sequence: emit one replacement
                        // char, drop the offending bytes, and keep decoding
                        // whatever follows in this same push.
                        Some(bad_len) => {
                            out.push('\u{FFFD}');
                            self.buf.drain(..valid_up_to + bad_len);
                        }
                        // Incomplete sequence trailing the buffer (e.g. we
                        // only have the lead byte of a multi-byte char so
                        // far): keep it buffered for the next push.
                        None => {
                            self.buf.drain(..valid_up_to);
                            // Defensive cap: a genuine incomplete UTF-8 tail
                            // is at most 3 bytes. If it ever grows past
                            // that, treat the stuck lead byte as invalid
                            // rather than buffering forever.
                            if self.buf.len() > 3 {
                                out.push('\u{FFFD}');
                                self.buf.remove(0);
                                continue;
                            }
                            break;
                        }
                    }
                }
            }
        }

        out
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// The child itself lives on the exit-monitor thread, which blocks in
    /// `wait`; a cloned killer is how `close` reaches it meanwhile.
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Shared with the reader thread's closure (cloned in before the thread
    /// is spawned in `open`), so appended output is visible here without the
    /// reader thread ever touching the sessions map.
    scrollback: Arc<Mutex<Scrollback>>,
    /// Shared with the reader and exit-monitor threads, which keep reporting
    /// on it after `close` has removed the session from the map.
    record: Arc<SessionRecord>,
}

/// Lock order, where more than one is held: the sessions map, then the
/// clock's revision, then one session's lifecycle.
/// How long a stop may take to show as an exit before the process is taken
/// to be still running. Killing a console process usually ends it within
/// milliseconds.
const STOP_CONFIRM_TIMEOUT: Duration = Duration::from_secs(3);

/// What Stop all did; see `TerminalSessions::close_all`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseAllReport {
    pub requested: usize,
    pub failed: Vec<StopFailure>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopFailure {
    pub session_id: String,
    pub error: String,
}

pub struct TerminalSessions {
    inner: Arc<Mutex<HashMap<String, Session>>>,
    clock: Arc<Clock>,
}

impl Default for TerminalSessions {
    fn default() -> Self {
        Self::with_sink(Arc::new(|_| {}))
    }
}

impl TerminalSessions {
    /// `sink` receives every lifecycle change, in revision order; the app
    /// emits it as `terminal://session`.
    pub fn with_sink(sink: SessionSink) -> Self {
        TerminalSessions {
            inner: Arc::default(),
            clock: Arc::new(Clock::new(sink)),
        }
    }

    /// `on_bytes` is called once per decoded chunk with `(text, seq)`, where
    /// `seq` is the cumulative byte count of this session's output as of and
    /// including this chunk (see `Scrollback::push`) -- callers that emit an
    /// event to the renderer (`terminal::commands`) forward it verbatim so a
    /// newly-attaching listener can reconcile live events against a
    /// `scrollback` snapshot without gap or duplicate.
    ///
    /// Returns the new session's facts. Its `running` event has already been
    /// handed to the sink by then, and the session is already listed.
    pub fn open(
        &self,
        cfg: SpawnConfig,
        on_bytes: impl Fn(String, u64) + Send + 'static,
    ) -> Result<TerminalSessionInfo, String> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: cfg.rows,
                cols: cfg.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty:{e}"))?;

        let (mut cmd, program_name) = match &cfg.target {
            SpawnTarget::Shell(kind) => {
                let resolved = resolve_requested_shell(*kind)?;
                (resolved.command(), program_file_name(&resolved.program))
            }
            SpawnTarget::Program { program, args } => {
                let mut c = CommandBuilder::new(program);
                c.args(args);
                (c, program_file_name(program))
            }
        };
        // Only hand over a directory that exists on this machine; never
        // invent a path, and never start in a network share (reaching one
        // sends the user's credentials to its host).
        let initial_cwd = cfg
            .cwd
            .filter(|dir| crate::validation::validate_existing_folder(dir).is_ok())
            .or_else(default_spawn_dir);
        if let Some(dir) = initial_cwd.as_ref() {
            cmd.cwd(dir);
        }
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn:{e}"))?;
        let started = Instant::now();
        let started_at_ms = now_epoch_ms();
        drop(pair.slave);
        let killer = child.clone_killer();
        let pid = child.process_id();

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("reader:{e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("writer:{e}"))?;

        let id = uuid::Uuid::new_v4().to_string();
        let scrollback = Arc::new(Mutex::new(Scrollback::default()));
        // Cloned in before the thread starts so the thread never needs
        // access to `self.inner` (and so scrollback keeps accumulating even
        // if the caller is mid-`insert` below, though in practice the thread
        // cannot produce output before the child has been spawned, which has
        // already happened by this point).
        let scrollback_for_thread = scrollback.clone();

        let record = Arc::new(SessionRecord::new(SessionFacts {
            session_id: id.clone(),
            origin: cfg.origin,
            pid,
            program_name,
            started_at_ms,
            started,
            initial_cwd,
        }));
        // Listed and announced before either thread can report an end, so
        // `running` always carries the session's lowest revision.
        let info = {
            let mut map = self.inner.lock().unwrap();
            map.insert(
                id.clone(),
                Session {
                    master: pair.master,
                    writer,
                    killer,
                    scrollback,
                    record: record.clone(),
                },
            );
            self.clock
                .change(&record, |_| true)
                .expect("announcing a new session always changes it")
        };

        let clock_for_reader = self.clock.clone();
        let record_for_reader = record.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            // One chunker per session, owned by this thread: it carries any
            // incomplete trailing UTF-8 sequence across reads so multi-byte
            // characters split at an 8192-byte read boundary decode intact.
            let mut chunker = Utf8Chunker::default();
            let clean = loop {
                match reader.read(&mut buf) {
                    Ok(0) => break true,
                    Err(_) => break false,
                    Ok(n) => {
                        let decoded = chunker.push(&buf[..n]);
                        if !decoded.is_empty() {
                            // Buffer before emitting: a listener that
                            // subscribes to live events and then fetches the
                            // scrollback snapshot must never observe a chunk
                            // in neither place, though it may see the same
                            // chunk in both (that is what `seq`/`cursor`
                            // reconciliation on the caller side is for).
                            let seq = scrollback_for_thread.lock().unwrap().push(&decoded);
                            on_bytes(decoded, seq);
                        }
                    }
                }
            };
            // The stream closing says nothing about the process: a shell can
            // exit while a grandchild holds the PTY open, and this can fire
            // while the shell lives on.
            clock_for_reader.change(&record_for_reader, |life| record_stream_end(life, clean));
            // The reader thread is the sole other owner of `scrollback_for_
            // thread`; dropping it here (loop exit means the PTY closed) and
            // `close`/`close_all` removing the session's own `Arc` are
            // together what actually frees the buffer -- neither alone
            // would, since each holds a strong reference.
        });

        let clock_for_monitor = self.clock.clone();
        std::thread::spawn(move || {
            // The only place a process end is established. EOF on the
            // reader is not evidence of it (see above).
            let waited = child.wait().ok().map(|status| status.exit_code());
            clock_for_monitor.change(&record, |life| record_exit(life, waited, now_epoch_ms()));
        });

        Ok(info)
    }

    /// Every session still in the registry -- running, stopping, or ended on
    /// its own but not yet closed -- with the revision the snapshot covers.
    /// A closed session is gone from here; its last events still went out.
    pub fn list(&self) -> TerminalSessionList {
        let map = self.inner.lock().unwrap();
        self.clock.snapshot(map.values().map(|s| &s.record))
    }

    /// Fetch what a session has produced so far, for a surface that attaches
    /// after some of it was already emitted. Returns the buffered
    /// text (oldest-first, capped at `SCROLLBACK_CAP_BYTES` -- see that
    /// constant's doc comment for exactly what is and is not guaranteed) and
    /// `cursor`, the cumulative byte count as of this snapshot. A caller
    /// should apply the text first, then replay any live `terminal://data`
    /// event whose `seq` exceeds `cursor` -- one whose `seq` is `<= cursor`
    /// is already represented in `text` and must be dropped, not reapplied.
    pub fn scrollback(&self, id: &str) -> Result<(String, u64), String> {
        let guard = self.inner.lock().unwrap();
        let s = guard.get(id).ok_or("unknown_session")?;
        let sb = s.scrollback.lock().unwrap();
        Ok((sb.buf.clone(), sb.total_bytes))
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap();
        let s = guard.get_mut(id).ok_or("unknown_session")?;
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("write:{e}"))?;
        s.writer.flush().map_err(|e| format!("flush:{e}"))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self.inner.lock().unwrap();
        let s = guard.get(id).ok_or("unknown_session")?;
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize:{e}"))
    }

    /// Idempotent: closing a session that is absent (already closed, or
    /// never existed) succeeds rather than erroring, matching `close_all`'s
    /// tolerance. Callers such as an effect-cleanup `dispose()` may race a
    /// prior `closeAll()` or a repeated close, and must never surface that
    /// as an error.
    ///
    /// `guard.remove` drops this session's `Session`, including its
    /// `scrollback` `Arc`. What is unconditional is the *reachability*: the
    /// id is gone from the map, so `scrollback(id)` on a closed id reports
    /// `unknown_session` rather than returning stale text, and nothing can
    /// read those bytes again through any API here.
    ///
    /// Reclaiming the buffer's *memory* is conditional, and worth stating
    /// plainly rather than implying. Two strong references exist: this one
    /// and the reader thread's clone. The thread drops its clone only when
    /// it leaves its read loop, which happens when the PTY's read end
    /// closes. Killing the direct child usually does that -- but the child
    /// is not necessarily the last holder. If it spawned a detached
    /// grandchild that inherited the PTY handle, the handle stays open for
    /// that process's lifetime, the reader thread parks in `read`, and its
    /// `Arc` clone keeps the buffer alive (bounded by
    /// `SCROLLBACK_CAP_BYTES`) until the grandchild exits. So: closing a
    /// session always makes its bytes unreachable; it frees them promptly
    /// only when nothing else is holding the PTY open.
    ///
    /// A session still running is marked `stopping` before the kill, so the
    /// exit the monitor then records reads as `stopped`, not natural.
    ///
    /// The one error is a stop that could not be confirmed: see `stop_each`.
    pub fn close(&self, id: &str) -> Result<(), String> {
        let removed = self.inner.lock().unwrap().remove(id);
        let Some(s) = removed else {
            return Ok(());
        };
        match self.stop_each(vec![(id.to_owned(), s)]).pop() {
            Some(failure) => Err(failure.error),
            None => Ok(()),
        }
    }

    /// Stop every session. `requested` counts the stop requests sent, not
    /// confirmed ends (each exit arrives as a session event); `failed` names
    /// the sessions whose kill was refused while they still ran. Those stay
    /// in the registry, reported running, so Stop all or a close by id can
    /// try them again.
    pub fn close_all(&self) -> CloseAllReport {
        let drained: Vec<(String, Session)> = self.inner.lock().unwrap().drain().collect();
        let requested = drained.len();
        let failed = self.stop_each(drained);
        CloseAllReport { requested, failed }
    }

    /// Kill each session already taken out of the map, then wait, up to
    /// `STOP_CONFIRM_TIMEOUT` for all of them together, until the exit
    /// monitor has seen each one end. The kill's own result is not used:
    /// portable-pty 0.8's Windows killer returns an error when
    /// TerminateProcess succeeds and Ok when it fails. A process whose exit is
    /// not seen in time is still running: it goes back under its id, is
    /// reported running again and is returned as a failure, because dropping
    /// it would leave a live process nothing could stop.
    fn stop_each(&self, sessions: Vec<(String, Session)>) -> Vec<StopFailure> {
        let mut sessions = sessions;
        for (_, s) in &mut sessions {
            self.clock.change(&s.record, request_stop);
            let _ = s.killer.kill();
        }
        let deadline = Instant::now() + STOP_CONFIRM_TIMEOUT;
        let mut failed = Vec::new();
        for (id, s) in sessions {
            while s.record.is_stopping() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if self.clock.change(&s.record, stop_refused).is_some() {
                self.inner.lock().unwrap().insert(id.clone(), s);
                failed.push(StopFailure {
                    session_id: id,
                    error: "stop_not_confirmed".into(),
                });
            }
        }
        failed
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn count(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

/// Pure logic for `Scrollback` -- no PTY, so these run on every platform,
/// unlike the PTY-backed suite below which is Windows-only like the rest of
/// this module's tests.
#[cfg(test)]
mod scrollback_tests {
    use super::*;

    #[test]
    fn push_returns_the_cumulative_byte_count_as_seq() {
        let mut sb = Scrollback::default();
        assert_eq!(sb.push("ab"), 2);
        assert_eq!(sb.push("cde"), 5);
        assert_eq!(sb.buf, "abcde");
    }

    #[test]
    fn caps_buffered_bytes_and_drops_oldest_first() {
        let mut sb = Scrollback::default();
        let filler = "a".repeat(SCROLLBACK_CAP_BYTES);
        sb.push(&filler);
        assert_eq!(sb.buf.len(), SCROLLBACK_CAP_BYTES);

        sb.push("NEWEST");
        // Cap held steady, and it's the newest content that survives.
        assert_eq!(sb.buf.len(), SCROLLBACK_CAP_BYTES);
        assert!(sb.buf.ends_with("NEWEST"));
    }

    #[test]
    fn total_bytes_keeps_counting_past_the_cap_while_buf_stays_bounded() {
        let mut sb = Scrollback::default();
        let chunk = "a".repeat(SCROLLBACK_CAP_BYTES + 100);
        let seq = sb.push(&chunk);
        assert_eq!(seq, (SCROLLBACK_CAP_BYTES + 100) as u64);
        assert_eq!(sb.buf.len(), SCROLLBACK_CAP_BYTES);
    }

    #[test]
    fn trims_oldest_content_without_splitting_a_leading_multi_byte_character() {
        let mut sb = Scrollback::default();
        // "─" is 3 bytes; as the very first content pushed, it becomes the
        // oldest bytes in the buffer -- exactly what a later trim removes
        // first.
        sb.push("─");
        // Push just enough more that the excess (1 byte) lands the naive cut
        // point inside that leading character (byte offset 1 of 3), forcing
        // the boundary-search loop to walk forward to offset 3 instead of
        // producing invalid UTF-8 or an in-place panic.
        let filler = "a".repeat(SCROLLBACK_CAP_BYTES - 2);
        sb.push(&filler);

        assert!(std::str::from_utf8(sb.buf.as_bytes()).is_ok());
        assert!(
            !sb.buf.contains('─'),
            "the whole leading character should have been dropped, never split: {:?}",
            &sb.buf[..sb.buf.len().min(8)]
        );
        assert_eq!(sb.buf.len(), SCROLLBACK_CAP_BYTES - 2);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// How long a PowerShell test may wait for output. A hang detector, not a
    /// pace: the loops poll and leave as soon as the text arrives (locally in
    /// well under a second). On the Windows CI runner Windows PowerShell has
    /// twice printed its first banner line and then nothing more for 10 s, with
    /// no Rust change (CI 36768329260 attempt 1 and 36770538456).
    const SHELL_START_DEADLINE: Duration = Duration::from_secs(30);

    #[test]
    fn utf8_chunker_reassembles_two_byte_char_split_across_pushes() {
        // "ç" = 0xC3 0xA7. Splitting after the lead byte must not emit
        // U+FFFD; the lead byte should be held back until it completes.
        let mut chunker = Utf8Chunker::default();
        assert_eq!(chunker.push(&[0xC3]), "");
        assert_eq!(chunker.push(&[0xA7]), "ç");
    }

    #[test]
    fn utf8_chunker_reassembles_three_byte_char_split_across_three_pushes() {
        // Box-drawing "─" = 0xE2 0x94 0x80.
        let mut chunker = Utf8Chunker::default();
        assert_eq!(chunker.push(&[0xE2]), "");
        assert_eq!(chunker.push(&[0x94]), "");
        assert_eq!(chunker.push(&[0x80]), "─");

        // Also verify a two-way split reassembles exactly once.
        let mut chunker2 = Utf8Chunker::default();
        assert_eq!(chunker2.push(&[0xE2, 0x94]), "");
        assert_eq!(chunker2.push(&[0x80]), "─");
    }

    #[test]
    fn utf8_chunker_passes_through_whole_string_unchanged() {
        let mut chunker = Utf8Chunker::default();
        let s = "hello ışık dünya ─── box";
        assert_eq!(chunker.push(s.as_bytes()), s);
    }

    #[test]
    fn utf8_chunker_invalid_byte_yields_replacement_and_does_not_wedge() {
        let mut chunker = Utf8Chunker::default();
        // 0xFF is never valid UTF-8 (lone invalid byte).
        let out1 = chunker.push(&[0xFF]);
        assert_eq!(out1, "\u{FFFD}");

        // Subsequent valid input must decode normally afterwards.
        let out2 = chunker.push("ok".as_bytes());
        assert_eq!(out2, "ok");
    }

    #[test]
    fn open_registers_a_session_and_streams_output() {
        let sessions = TerminalSessions::default();
        let sink = Arc::new(Mutex::new(String::new()));
        let sink_w = sink.clone();
        // cmd.exe is always present on Windows CI; `ver` prints and exits.
        let id = sessions
            .open(
                SpawnConfig {
                    target: SpawnTarget::Shell(ShellKind::PowerShell),
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    origin: SessionOrigin::User,
                },
                move |chunk, _seq| sink_w.lock().unwrap().push_str(&chunk),
            )
            .expect("open")
            .session_id;
        assert_eq!(sessions.count(), 1);

        sessions.write(&id, "echo qutra_marker\r\n").expect("write");

        let deadline = Instant::now() + SHELL_START_DEADLINE;
        loop {
            if sink.lock().unwrap().contains("qutra_marker") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "no marker echoed: {}",
                sink.lock().unwrap()
            );
            std::thread::sleep(Duration::from_millis(50));
        }

        sessions.close(&id).expect("close");
        assert_eq!(sessions.count(), 0);
    }

    #[test]
    fn open_runs_a_program_target_and_streams_its_output() {
        let sessions = TerminalSessions::default();
        let sink = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let w = sink.clone();
        // cmd.exe is always present; /c echo prints and exits.
        let id = sessions
            .open(
                SpawnConfig {
                    target: SpawnTarget::Program {
                        program: "cmd.exe".into(),
                        args: vec!["/c".into(), "echo".into(), "qutra_prog".into()],
                    },
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    origin: SessionOrigin::User,
                },
                move |chunk, _seq| w.lock().unwrap().push_str(&chunk),
            )
            .expect("open program")
            .session_id;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if sink.lock().unwrap().contains("qutra_prog") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "no output: {}",
                sink.lock().unwrap()
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        sessions.close(&id).expect("close");
    }

    /// The assumption this closes: the tool registry stores paths as
    /// `fs::canonicalize` output, which on Windows is the **verbatim**
    /// `\\?\C:\...` form. That form has been proven through
    /// `std::process::Command` (the batch and detached launch routes) but
    /// never through ConPTY, which is a different spawn path entirely --
    /// every PTY test in this file used a bare name or a fake path. So an
    /// interactive tool launch was resting on an untested assumption.
    ///
    /// This spawns a real PTY from a really-canonicalized path and requires
    /// its output to arrive. `COMSPEC` is used rather than a hard-coded
    /// path so the test follows the machine's actual cmd.exe.
    #[test]
    fn program_target_spawns_from_a_verbatim_canonicalized_path() {
        let comspec =
            std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string());
        let canonical = std::fs::canonicalize(&comspec)
            .unwrap_or_else(|e| panic!("canonicalize {comspec}: {e}"));
        let program = canonical.to_string_lossy().to_string();

        // Guard the premise: if this ever stops producing a verbatim path,
        // the test below would be proving something else without saying so.
        assert!(
            program.starts_with(r"\\?\"),
            "expected fs::canonicalize to yield a verbatim path, got {program}"
        );

        let sessions = TerminalSessions::default();
        let sink = Arc::new(Mutex::new(String::new()));
        let w = sink.clone();
        let id = sessions
            .open(
                SpawnConfig {
                    target: SpawnTarget::Program {
                        program: program.clone(),
                        args: vec!["/c".into(), "echo".into(), "qutra_verbatim".into()],
                    },
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    origin: SessionOrigin::User,
                },
                move |chunk, _seq| w.lock().unwrap().push_str(&chunk),
            )
            .unwrap_or_else(|e| {
                panic!("ConPTY refused a verbatim canonicalized path: {e} (program={program})")
            })
            .session_id;

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            // Copy out and release the lock before any panic: holding the
            // guard across `assert!` poisons the mutex, and the reader
            // thread's next `lock().unwrap()` then panics too, burying the
            // real message under a `PoisonError`.
            let seen = sink.lock().unwrap().clone();
            if seen.contains("qutra_verbatim") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "spawned from a verbatim path but no output arrived: {seen:?}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }

        sessions.close(&id).expect("close");
    }

    #[test]
    fn write_to_unknown_session_errors() {
        let sessions = TerminalSessions::default();
        assert!(sessions.write("nope", "x").is_err());
    }

    #[test]
    fn close_unknown_session_is_idempotent() {
        let sessions = TerminalSessions::default();
        assert!(sessions.close("nope").is_ok());
    }

    #[test]
    fn scrollback_of_unknown_session_errors() {
        let sessions = TerminalSessions::default();
        assert!(sessions.scrollback("nope").is_err());
    }

    #[test]
    fn shell_chain_prefers_pwsh_when_the_lookup_finds_it() {
        let exists = |name: &str| name == "pwsh.exe";
        let resolved = resolve_shell(
            ShellKind::Pwsh,
            exists,
            Some(r"C:\Windows\System32\cmd.exe"),
        )
        .expect("pwsh present");
        assert_eq!(resolved.kind, ShellKind::Pwsh);
        assert_eq!(resolved.program, "pwsh.exe");
    }

    #[test]
    fn shell_chain_falls_to_powershell_when_pwsh_is_absent() {
        let exists = |name: &str| name == "powershell.exe";
        let resolved = resolve_shell(
            ShellKind::Pwsh,
            exists,
            Some(r"C:\Windows\System32\cmd.exe"),
        )
        .expect("powershell present");
        assert_eq!(resolved.kind, ShellKind::PowerShell);
        assert_eq!(resolved.program, "powershell.exe");
    }

    #[test]
    fn shell_chain_falls_to_comspec_when_neither_powershell_exists() {
        let exists = |_name: &str| false;
        let resolved = resolve_shell(
            ShellKind::Pwsh,
            exists,
            Some(r"C:\Windows\System32\cmd.exe"),
        )
        .expect("comspec");
        assert_eq!(resolved.kind, ShellKind::Cmd);
        assert_eq!(resolved.program, r"C:\Windows\System32\cmd.exe");
    }

    #[test]
    fn bash_is_not_a_member_of_the_windows_fallback() {
        let exists = |name: &str| name == "bash.exe";
        let resolved = resolve_shell(
            ShellKind::Pwsh,
            exists,
            Some(r"C:\Windows\System32\cmd.exe"),
        )
        .expect("comspec, not bash");
        assert_eq!(resolved.kind, ShellKind::Cmd);
        assert_ne!(resolved.program, "bash.exe");
    }

    #[test]
    fn explicit_bash_does_not_fall_back_to_comspec() {
        let exists = |_name: &str| false;
        let err = resolve_shell(
            ShellKind::Bash,
            exists,
            Some(r"C:\Windows\System32\cmd.exe"),
        )
        .expect_err("bash stays explicit");
        assert_eq!(err, "shell_not_found:bash");
    }

    /// The whole point of the scrollback: a surface that attaches late must recover
    /// everything a session produced, in order, with neither a gap (a byte
    /// that shows up in neither the snapshot nor a replayed live event) nor
    /// a duplicate (a byte that shows up in both). This proves it by taking
    /// a `scrollback` snapshot mid-stream -- exactly the race `wireFromId`
    /// resolves on the TS side -- then reconstructing the full output from
    /// that snapshot plus only the live events whose `seq` exceeds the
    /// snapshot's `cursor`, and checking the reconstruction's length against
    /// an independent measure of the true total (a second, later snapshot's
    /// `cursor`). If any live event were double-counted or dropped, the
    /// lengths would disagree.
    #[test]
    fn scrollback_snapshot_and_seq_filtered_live_events_have_no_gap_or_duplicate() {
        let sessions = TerminalSessions::default();
        let events: Arc<Mutex<Vec<(String, u64)>>> = Arc::new(Mutex::new(Vec::new()));
        let events_w = events.clone();
        let id = sessions
            .open(
                SpawnConfig {
                    target: SpawnTarget::Shell(ShellKind::PowerShell),
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    origin: SessionOrigin::User,
                },
                move |chunk, seq| events_w.lock().unwrap().push((chunk, seq)),
            )
            .expect("open")
            .session_id;

        sessions
            .write(&id, "echo qutra_scrollback_marker\r\n")
            .expect("write");

        // Snapshot mid-stream, as soon as anything at all has arrived --
        // this is the race window, deliberately not waited past.
        let deadline = Instant::now() + SHELL_START_DEADLINE;
        loop {
            if !events.lock().unwrap().is_empty() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "no output observed before deadline"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let (snapshot_text, cursor) = sessions.scrollback(&id).expect("scrollback");

        // Let the rest of the command's output land.
        let deadline = Instant::now() + SHELL_START_DEADLINE;
        loop {
            let joined: String = events
                .lock()
                .unwrap()
                .iter()
                .map(|(c, _)| c.as_str())
                .collect();
            if joined.contains("qutra_scrollback_marker") {
                break;
            }
            assert!(Instant::now() < deadline, "marker never appeared: {joined}");
            std::thread::sleep(Duration::from_millis(20));
        }

        // Reconstruct exactly as `wireFromId` does: the snapshot text, then
        // only the events that arrived after it.
        let all_events = events.lock().unwrap().clone();

        // Without this, the test can pass while proving nothing. If the
        // snapshot happens to be taken after the last chunk, every event is
        // filtered out, `reconstructed` is just the snapshot, and the
        // length check below holds trivially -- a green run that never
        // exercised the seq filter at all. Requiring at least one event past
        // the cursor makes the reconstruction actually do the work it
        // claims to.
        assert!(
            all_events.iter().any(|(_, seq)| *seq > cursor),
            "snapshot raced nothing"
        );

        let mut reconstructed = snapshot_text.clone();
        for (chunk, seq) in &all_events {
            if *seq > cursor {
                reconstructed.push_str(chunk);
            }
        }

        // Independent measure of the true total produced so far, taken
        // after everything above has already happened.
        let (_, final_cursor) = sessions.scrollback(&id).expect("scrollback");
        assert_eq!(
            reconstructed.len() as u64,
            final_cursor,
            "reconstructed length must exactly equal total bytes produced -- \
             short means a gap, long means a duplicate"
        );
        assert!(reconstructed.contains("qutra_scrollback_marker"));

        sessions.close(&id).expect("close");
    }

    /// A closed session's buffered bytes must not outlive it: `scrollback`
    /// on a closed id reports `unknown_session`, the same as any other
    /// operation on a gone session, rather than serving stale text.
    #[test]
    fn scrollback_is_gone_once_the_session_is_closed() {
        let sessions = TerminalSessions::default();
        let id = sessions
            .open(
                SpawnConfig {
                    target: SpawnTarget::Shell(ShellKind::PowerShell),
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    origin: SessionOrigin::User,
                },
                |_chunk, _seq| {},
            )
            .expect("open")
            .session_id;
        sessions.write(&id, "echo hi\r\n").expect("write");
        sessions.close(&id).expect("close");
        assert!(sessions.scrollback(&id).is_err());
    }

    use lifecycle::{ExitReason, IoState, ProcessState, TerminalSessionEvent};

    type Events = Arc<Mutex<Vec<TerminalSessionEvent>>>;

    fn recording_sessions() -> (TerminalSessions, Events) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let sessions = TerminalSessions::with_sink(Arc::new(move |e: &TerminalSessionEvent| {
            sink_events.lock().unwrap().push(e.clone())
        }));
        (sessions, events)
    }

    /// Wait until an event for `id` satisfies `done`, then return it.
    fn wait_for_event(
        events: &Events,
        id: &str,
        done: impl Fn(&TerminalSessionEvent) -> bool,
    ) -> TerminalSessionEvent {
        let deadline = Instant::now() + SHELL_START_DEADLINE;
        loop {
            let seen = events.lock().unwrap().clone();
            if let Some(e) = seen.iter().find(|e| e.session.session_id == id && done(e)) {
                return e.clone();
            }
            assert!(Instant::now() < deadline, "event never arrived: {seen:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn program(program: &str, args: &[&str], cwd: Option<String>) -> SpawnConfig {
        SpawnConfig {
            target: SpawnTarget::Program {
                program: program.into(),
                args: args.iter().map(|a| a.to_string()).collect(),
            },
            cwd,
            cols: 80,
            rows: 24,
            origin: SessionOrigin::User,
        }
    }

    #[test]
    fn open_reports_rust_derived_facts_and_announces_running_first() {
        let (sessions, events) = recording_sessions();
        let dir = tempfile::tempdir().unwrap();
        let dir_text = dir.path().to_string_lossy().into_owned();
        let info = sessions
            .open(
                SpawnConfig {
                    target: SpawnTarget::Shell(ShellKind::PowerShell),
                    cwd: Some(dir_text.clone()),
                    cols: 80,
                    rows: 24,
                    origin: SessionOrigin::Assistant,
                },
                |_, _| {},
            )
            .expect("open");

        assert_eq!(info.state, ProcessState::Running);
        assert_eq!(info.io_state, IoState::Open);
        assert!(info.pid.is_some_and(|pid| pid > 0), "{info:?}");
        assert_eq!(info.program_name, "powershell.exe");
        assert_eq!(info.origin, "assistant");
        assert_eq!(info.initial_cwd.as_deref(), Some(dir_text.as_str()));
        assert_eq!(info.exit, None);

        let first = events.lock().unwrap()[0].clone();
        assert_eq!(first.session, info, "open returns what it announced");
        let listed = sessions.list();
        assert_eq!(listed.runtime_id, info.runtime_id);
        assert_eq!(listed.sessions.len(), 1);
        assert_eq!(listed.sessions[0].session_id, info.session_id);

        sessions.close(&info.session_id).expect("close");
    }

    /// A share as the starting directory would make Windows reach out to its
    /// host with the user's credentials; the session starts in the profile.
    #[test]
    fn a_network_share_is_never_the_starting_directory() {
        let (sessions, _) = recording_sessions();
        let info = sessions
            .open(
                program(
                    "cmd.exe",
                    &["/c", "exit", "0"],
                    Some(r"\\localhost\c$".to_string()),
                ),
                |_, _| {},
            )
            .expect("open");
        assert_eq!(info.initial_cwd, default_spawn_dir());
        sessions.close(&info.session_id).expect("close");
    }

    #[test]
    fn a_session_given_no_directory_reports_the_profile_it_started_in() {
        let (sessions, _) = recording_sessions();
        let info = sessions
            .open(program("cmd.exe", &["/c", "exit", "0"], None), |_, _| {})
            .expect("open");
        assert_eq!(info.initial_cwd, default_spawn_dir());
        assert!(info.initial_cwd.is_some(), "USERPROFILE exists on Windows");
        sessions.close(&info.session_id).expect("close");
    }

    #[test]
    fn a_program_that_ends_on_its_own_reports_a_natural_exit_and_its_code() {
        let (sessions, events) = recording_sessions();
        let info = sessions
            .open(program("cmd.exe", &["/c", "exit", "7"], None), |_, _| {})
            .expect("open");
        assert_eq!(info.program_name, "cmd.exe");

        let exited = wait_for_event(&events, &info.session_id, |e| {
            e.session.state == ProcessState::Exited
        });
        let exit = exited
            .session
            .exit
            .expect("an exited session carries its exit");
        assert_eq!(exit.code, 7);
        assert_eq!(exit.reason, ExitReason::Natural);
        assert!(exit.ended_at >= info.started_at);

        // Ended on its own but not closed: still listed, so a tab can show
        // how it ended.
        let listed = sessions.list();
        assert_eq!(listed.sessions[0].state, ProcessState::Exited);
        assert!(listed.revision >= exited.revision);

        sessions.close(&info.session_id).expect("close");
        assert!(sessions.list().sessions.is_empty());
    }

    #[test]
    fn closing_a_running_shell_reports_stopping_then_a_stopped_exit_in_revision_order() {
        let (sessions, events) = recording_sessions();
        let info = sessions
            .open(
                SpawnConfig {
                    target: SpawnTarget::Shell(ShellKind::PowerShell),
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    origin: SessionOrigin::User,
                },
                |_, _| {},
            )
            .expect("open");

        sessions.close(&info.session_id).expect("close");
        let exited = wait_for_event(&events, &info.session_id, |e| {
            e.session.state == ProcessState::Exited
        });
        assert_eq!(exited.session.exit.unwrap().reason, ExitReason::Stopped);

        let seen = events.lock().unwrap().clone();
        let states: Vec<ProcessState> = seen.iter().map(|e| e.session.state).collect();
        let stopping = states.iter().position(|s| *s == ProcessState::Stopping);
        let ended = states.iter().position(|s| *s == ProcessState::Exited);
        assert!(
            stopping < ended,
            "stopping must precede the exit: {states:?}"
        );
        assert!(
            seen.windows(2).all(|w| w[0].revision < w[1].revision),
            "events must leave in revision order: {seen:?}"
        );
        assert!(sessions.list().sessions.is_empty());
    }

    #[test]
    fn close_all_reports_every_running_session_as_stopped() {
        let (sessions, events) = recording_sessions();
        let shell = || SpawnConfig {
            target: SpawnTarget::Shell(ShellKind::PowerShell),
            cwd: None,
            cols: 80,
            rows: 24,
            origin: SessionOrigin::User,
        };
        let a = sessions.open(shell(), |_, _| {}).expect("open a");
        let b = sessions.open(shell(), |_, _| {}).expect("open b");

        let report = sessions.close_all();
        assert_eq!(report.requested, 2);
        assert!(report.failed.is_empty());
        for id in [&a.session_id, &b.session_id] {
            let exited = wait_for_event(&events, id, |e| e.session.state == ProcessState::Exited);
            assert_eq!(exited.session.exit.unwrap().reason, ExitReason::Stopped);
        }
    }

    /// Stands in for a kill Windows refuses (access denied and the like).
    #[derive(Debug)]
    struct RefusingKiller;

    impl ChildKiller for RefusingKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "kill refused",
            ))
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(RefusingKiller)
        }
    }

    #[test]
    fn a_refused_kill_keeps_the_session_listed_running_and_stoppable() {
        let (sessions, _events) = recording_sessions();
        let shell = || SpawnConfig {
            target: SpawnTarget::Shell(ShellKind::PowerShell),
            cwd: None,
            cols: 80,
            rows: 24,
            origin: SessionOrigin::User,
        };
        let stubborn = sessions.open(shell(), |_, _| {}).expect("open stubborn");
        let normal = sessions.open(shell(), |_, _| {}).expect("open normal");
        let real_killer = {
            let mut map = sessions.inner.lock().unwrap();
            let session = map.get_mut(&stubborn.session_id).unwrap();
            std::mem::replace(&mut session.killer, Box::new(RefusingKiller))
        };

        let report = sessions.close_all();

        assert_eq!(report.requested, 2);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].session_id, stubborn.session_id);
        let listed = sessions.list();
        assert_eq!(
            listed.sessions.len(),
            1,
            "the refused session stays in the registry"
        );
        assert_eq!(listed.sessions[0].session_id, stubborn.session_id);
        assert_eq!(listed.sessions[0].state, ProcessState::Running);
        assert!(
            sessions.close(&stubborn.session_id).is_err(),
            "close by id reports it too"
        );
        assert_eq!(sessions.list().sessions.len(), 1);

        // With a kill that works, the same session can be stopped by id.
        sessions
            .inner
            .lock()
            .unwrap()
            .get_mut(&stubborn.session_id)
            .unwrap()
            .killer = real_killer;
        sessions.close(&stubborn.session_id).expect("retry by id");
        assert!(sessions.list().sessions.is_empty());
        let _ = normal;
    }
}
