//! Dispatch gate for agent side effects (TM-005).
//!
//! Consent used to be read once at the start of `tools::execute`, and the
//! call then ran on the blocking pool. Aborting the async task does not stop
//! a closure already on that pool, so a spawn or a PTY write could still
//! happen after Stop or a Private Lab revoke.
//!
//! A ticket captures the generation. `invalidate` bumps it. `commit` runs the
//! side effect only while holding this gate's lock, and only if the ticket
//! still matches and `still_authorized` is true. A revoke or Stop that arrives
//! first makes the side effect not run. One that arrives during the side
//! effect waits until that side effect has finished. This does not undo an
//! action that already committed.
//!
//! Lock order: never take this lock while holding another lock, and never
//! hold it across an `.await`. Callers acquire it only inside `commit` /
//! `ticket` / `invalidate`, after they have released every other lock.

use std::sync::Mutex;

use super::error::AssistantError;

/// Generation captured before consent is read for a step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticket(u64);

/// Process-wide generation for agent side effects.
pub struct DispatchGate {
    generation: Mutex<u64>,
}

impl DispatchGate {
    pub fn new() -> Self {
        Self {
            generation: Mutex::new(0),
        }
    }

    pub fn ticket(&self) -> Ticket {
        Ticket(*self.lock())
    }

    /// Bump the generation. Tickets already handed out never match again.
    /// The counter saturates instead of wrapping, so it cannot return to a
    /// value an old ticket still holds.
    pub fn invalidate(&self) {
        let mut generation = self.lock();
        *generation = generation.saturating_add(1);
    }

    /// Run `side_effect` while holding the gate lock, or return `Cancelled`.
    pub fn commit<F, T>(
        &self,
        ticket: Ticket,
        still_authorized: impl FnOnce() -> bool,
        side_effect: F,
    ) -> Result<T, AssistantError>
    where
        F: FnOnce() -> Result<T, AssistantError>,
    {
        let generation = self.lock();
        if *generation != ticket.0 || !still_authorized() {
            return Err(AssistantError::Cancelled);
        }
        side_effect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, u64> {
        match self.generation.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl Default for DispatchGate {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;

    use super::*;

    #[test]
    fn a_ticket_taken_before_invalidate_never_runs_its_side_effect() {
        let gate = DispatchGate::new();
        let ticket = gate.ticket();
        gate.invalidate();
        let mut ran = false;
        let result = gate.commit(
            ticket,
            || true,
            || {
                ran = true;
                Ok(())
            },
        );
        assert!(matches!(result, Err(AssistantError::Cancelled)));
        assert!(!ran);
    }

    #[test]
    fn a_regrant_does_not_revive_an_old_ticket() {
        let gate = DispatchGate::new();
        let stale = gate.ticket();
        gate.invalidate();
        let fresh = gate.ticket();
        assert_ne!(stale, fresh);

        let mut ran = false;
        assert!(matches!(
            gate.commit(
                stale,
                || true,
                || {
                    ran = true;
                    Ok(())
                }
            ),
            Err(AssistantError::Cancelled)
        ));
        assert!(!ran);

        assert!(gate.commit(fresh, || true, || Ok(())).is_ok());
    }

    #[test]
    fn still_authorized_false_blocks_the_side_effect() {
        let gate = DispatchGate::new();
        let ticket = gate.ticket();
        let mut ran = false;
        let result = gate.commit(
            ticket,
            || false,
            || {
                ran = true;
                Ok(())
            },
        );
        assert!(matches!(result, Err(AssistantError::Cancelled)));
        assert!(!ran);
    }

    #[test]
    fn a_racing_invalidate_either_precedes_the_side_effect_or_waits_for_it() {
        for _ in 0..1_000 {
            let gate = Arc::new(DispatchGate::new());
            let ticket = gate.ticket();
            let invalidate_returned = Arc::new(AtomicBool::new(false));
            let late = Arc::new(AtomicBool::new(false));
            let barrier = Arc::new(Barrier::new(2));

            let worker_gate = gate.clone();
            let worker_returned = invalidate_returned.clone();
            let worker_late = late.clone();
            let worker_barrier = barrier.clone();
            let worker = thread::spawn(move || {
                worker_barrier.wait();
                let _ = worker_gate.commit(
                    ticket,
                    || true,
                    || {
                        if worker_returned.load(Ordering::SeqCst) {
                            worker_late.store(true, Ordering::SeqCst);
                        }
                        // Yield while still inside commit. If this closure is not
                        // holding the gate lock, invalidate can return and set the
                        // flag before the second load.
                        thread::yield_now();
                        if worker_returned.load(Ordering::SeqCst) {
                            worker_late.store(true, Ordering::SeqCst);
                        }
                        Ok::<(), AssistantError>(())
                    },
                );
            });

            barrier.wait();
            gate.invalidate();
            invalidate_returned.store(true, Ordering::SeqCst);
            worker.join().unwrap();
            assert!(
                !late.load(Ordering::SeqCst),
                "side effect ran after invalidate returned"
            );
        }
    }
}
