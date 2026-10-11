//! Leaving the app.
//!
//! Closing the last window ends the event loop, and Tauri then runs every
//! plugin's exit hook before the process ends. One of those hooks (the SQL
//! plugin closing its pools) waits with no limit, so a connection that is
//! never handed back leaves a process with no window, and with it the engine
//! it started. The order here keeps that from mattering:
//!
//! 1. the first exit request arms a watchdog that ends the process after
//!    `HARD_EXIT_AFTER` whatever is still running (the job object then takes
//!    the engine down with it);
//! 2. the engine is stopped, a turn in flight getting a short grace;
//! 3. Tauri carries on with its own exit, and the process ends.
//!
//! The watchdog records the stage it found the exit in, so a stuck exit
//! names itself in `exit.log`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// How long an answer in flight may finish before the engine is killed.
pub const ENGINE_GRACE: Duration = Duration::from_millis(1500);
/// Longest an exit may take before the process is ended anyway.
pub const HARD_EXIT_AFTER: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Not leaving.
    Running,
    /// Stopping the engine.
    StoppingEngine,
    /// The engine is gone; Tauri and its plugins are finishing.
    Cleanup,
    /// Every exit hook has returned.
    Done,
}

impl Stage {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Stage::StoppingEngine,
            2 => Stage::Cleanup,
            3 => Stage::Done,
            _ => Stage::Running,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Stage::Running => "running",
            Stage::StoppingEngine => "stopping the engine",
            Stage::Cleanup => "plugin and window cleanup",
            Stage::Done => "done",
        }
    }
}

/// Where an exit has got to. One per app.
#[derive(Default)]
pub struct ExitState {
    begun: AtomicBool,
    stage: AtomicU8,
}

impl ExitState {
    /// True for the first caller only: every exit request after the first
    /// (the window closing and an explicit exit both ask) does nothing.
    fn begin(&self) -> bool {
        !self.begun.swap(true, Ordering::SeqCst)
    }

    fn set(&self, stage: Stage) {
        self.stage.store(stage as u8, Ordering::SeqCst);
    }

    pub fn stage(&self) -> Stage {
        Stage::from_u8(self.stage.load(Ordering::SeqCst))
    }

    /// Every exit hook has returned (the last event Tauri sends).
    pub fn finished(&self) {
        self.set(Stage::Done);
    }
}

/// Run the exit sequence once. `arm` starts the watchdog and must return
/// before the engine is touched; `stop_engine` may block for a while.
pub fn begin_exit(state: &ExitState, arm: impl FnOnce(), stop_engine: impl FnOnce()) -> bool {
    if !state.begin() {
        return false;
    }
    arm();
    state.set(Stage::StoppingEngine);
    stop_engine();
    state.set(Stage::Cleanup);
    true
}

/// Call `on_expire` with the stage reached once `after` has passed, from a
/// thread of its own. The process is normally gone long before.
pub fn arm_watchdog(
    state: Arc<ExitState>,
    after: Duration,
    on_expire: impl FnOnce(Stage) + Send + 'static,
) {
    let spawned = std::thread::Builder::new()
        .name("exit-watchdog".into())
        .spawn(move || {
            std::thread::sleep(after);
            on_expire(state.stage());
        });
    if spawned.is_err() {
        // No thread to watch with: the exit goes on without a watchdog.
        eprintln!("[Qutra Labs] could not start the exit watchdog");
    }
}

/// What the real watchdog does: note where the exit was stuck, then end the
/// process. Closing the process closes the job handle, which kills the
/// engine.
pub fn end_process(log: Option<PathBuf>, stage: Stage) -> ! {
    if stage != Stage::Done {
        let line = format!(
            "exit did not finish in {} s; stuck in: {}\n",
            HARD_EXIT_AFTER.as_secs(),
            stage.name()
        );
        eprintln!("[Qutra Labs] {line}");
        if let Some(path) = log {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, line);
        }
    }
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::Mutex;

    #[test]
    fn the_watchdog_is_armed_before_the_engine_is_touched_and_only_once() {
        let state = ExitState::default();
        let order = Mutex::new(Vec::new());
        let first = begin_exit(
            &state,
            || order.lock().unwrap().push("arm"),
            || order.lock().unwrap().push("stop engine"),
        );
        let second = begin_exit(
            &state,
            || order.lock().unwrap().push("arm again"),
            || order.lock().unwrap().push("stop engine again"),
        );
        assert!(first);
        assert!(!second, "a second exit request must do nothing");
        assert_eq!(*order.lock().unwrap(), vec!["arm", "stop engine"]);
        assert_eq!(state.stage(), Stage::Cleanup);
    }

    #[test]
    fn an_engine_stop_that_never_returns_is_caught_by_the_watchdog() {
        let state = Arc::new(ExitState::default());
        let (expired_tx, expired_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let exit = {
            let state = state.clone();
            std::thread::spawn(move || {
                let watched = state.clone();
                begin_exit(
                    &state,
                    move || {
                        arm_watchdog(watched, Duration::from_millis(100), move |stage| {
                            let _ = expired_tx.send(stage);
                        })
                    },
                    // The engine stop is stuck until the test lets it go.
                    move || {
                        let _ = release_rx.recv();
                    },
                )
            })
        };
        let stage = expired_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the watchdog fired");
        assert_eq!(stage, Stage::StoppingEngine);
        release_tx.send(()).unwrap();
        exit.join().unwrap();
    }

    #[test]
    fn a_hang_in_a_plugin_hook_is_reported_as_cleanup() {
        let state = Arc::new(ExitState::default());
        let (tx, rx) = mpsc::channel();
        let watched = state.clone();
        begin_exit(
            &state,
            move || {
                arm_watchdog(watched, Duration::from_millis(100), move |stage| {
                    let _ = tx.send(stage);
                })
            },
            || {},
        );
        // Nothing calls `finished`: a plugin's hook is still running.
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            Stage::Cleanup
        );
        state.finished();
        assert_eq!(state.stage(), Stage::Done);
    }
}
