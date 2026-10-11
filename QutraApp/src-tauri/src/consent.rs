//! Private Lab consent — the authorization gate for the native tool surface.
//!
//! See docs/decisions/0007-private-lab.md.
//!
//! The renderer already hides the Lab/Tools/Terminal surfaces behind the
//! `privateToolsEnabled` preference, but hiding UI is not authorization: that
//! preference lives entirely in the webview's document store, so anything that
//! reaches the webview (a deep link such as `/lab?view=tools`, a restored
//! session, a bug in a route guard) could previously drive real executables
//! without the user ever opting in.
//!
//! So consent is owned here instead, on the native side of the boundary:
//!
//! - it is **fail-closed** — unreadable, missing or malformed state denies;
//! - it is **persisted by the core**, not by the renderer, so a restart cannot
//!   silently come back up granted;
//! - it is checked by **every** tool command, not just the ones that spawn a
//!   process, because enumeration and registration are themselves part of the
//!   surface the user is consenting to.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard,
    },
    time::UNIX_EPOCH,
};

/// Stable error code returned to the renderer when consent is absent. The UI
/// maps this to the opt-in explanation; it is deliberately not a sentence, so
/// it never gets shown raw or localized inconsistently.
pub const CONSENT_REQUIRED: &str = "private_tools_consent_required";

/// File name under the app data directory holding the granted marker.
const CONSENT_FILE: &str = "private-tools-consent";

/// Stable error code when a revoke could not be written to disk. Consent is
/// already denied in memory when this is returned.
pub const CONSENT_PERSIST_FAILED: &str = "consent_persist_failed";

/// Written when consent is granted. Any other content reads as denied.
const GRANTED_MARKER: &str = "granted";

/// Written over the marker when a revoke cannot remove it.
const REVOKED_MARKER: &str = "revoked";

/// Native-owned consent state for the Private Lab tool surface.
pub struct PrivateToolsConsent {
    granted: AtomicBool,
    /// Held across every grant and revoke, disk and memory together, and
    /// counts revokes. A grant names the count it started under and commits
    /// only if no revoke has happened since, so a dialog answered after a
    /// withdrawal cannot bring consent back.
    generation: Mutex<u64>,
    path: PathBuf,
}

impl PrivateToolsConsent {
    /// Load persisted consent, defaulting to denied.
    ///
    /// Every failure path — missing file, unreadable file, unexpected content —
    /// resolves to denied rather than propagating an error, because a core that
    /// refuses to start is a worse outcome than a lab that asks the user to
    /// opt in again.
    pub fn load(app_data: &Path) -> Self {
        let path = app_data.join(CONSENT_FILE);
        let granted = fs::read_to_string(&path)
            .map(|raw| raw.trim() == GRANTED_MARKER)
            .unwrap_or(false);
        Self {
            granted: AtomicBool::new(granted),
            generation: Mutex::new(0),
            path,
        }
    }

    pub fn is_granted(&self) -> bool {
        self.granted.load(Ordering::SeqCst)
    }

    /// Since when consent holds, in milliseconds since the Unix epoch: the
    /// time the granted marker was last written, which survives a restart.
    /// `None` while denied, and whenever that time cannot be read; the page
    /// then shows the grant without a date rather than a wrong one.
    pub fn granted_since_ms(&self) -> Option<u64> {
        if !self.is_granted() {
            return None;
        }
        let written = fs::metadata(&self.path).ok()?.modified().ok()?;
        let since = written.duration_since(UNIX_EPOCH).ok()?;
        u64::try_from(since.as_millis()).ok()
    }

    /// The revoke count a grant request starts under. Read it before asking
    /// the user, and hand it to `grant` with the answer.
    pub fn generation(&self) -> u64 {
        *self.transition_lock()
    }

    /// Persist a grant the user confirmed under `generation`.
    ///
    /// `Ok(false)` means a revoke happened since that generation was read:
    /// nothing is written and consent stays denied. The in-memory flag is set
    /// only once the write succeeds, so a failed persist cannot leave a
    /// granted process whose next launch denies.
    pub fn grant(&self, generation: u64) -> Result<bool, String> {
        self.grant_with(generation, || {})
    }

    /// `between` runs after the marker is written and before memory is
    /// granted, so tests can land a revoke in that window.
    fn grant_with(&self, generation: u64, between: impl FnOnce()) -> Result<bool, String> {
        let current = self.transition_lock();
        if *current != generation {
            return Ok(false);
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&self.path, GRANTED_MARKER).map_err(|e| e.to_string())?;
        between();
        self.granted.store(true, Ordering::SeqCst);
        Ok(true)
    }

    /// Withdraw consent and invalidate every grant still waiting on a dialog.
    /// Fails closed: see `revoke_with`.
    pub fn revoke(&self) -> Result<(), String> {
        self.revoke_with(|path| fs::remove_file(path))
    }

    /// Deny in memory first, then persist. If the marker cannot be removed it
    /// is overwritten with a non-granted marker; if that fails too, the error
    /// is `CONSENT_PERSIST_FAILED` and this process stays denied anyway.
    fn revoke_with(&self, remove: impl FnOnce(&Path) -> std::io::Result<()>) -> Result<(), String> {
        let mut generation = self.transition_lock();
        *generation = generation.wrapping_add(1);
        self.granted.store(false, Ordering::SeqCst);
        match remove(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => fs::write(&self.path, REVOKED_MARKER)
                .map_err(|_| CONSENT_PERSIST_FAILED.to_string()),
        }
    }

    /// A poisoned lock still serializes: the counter is a plain integer and
    /// every writer leaves it valid.
    fn transition_lock(&self) -> MutexGuard<'_, u64> {
        match self.generation.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Guard for every native tool command.
    pub fn require(&self) -> Result<(), String> {
        if self.is_granted() {
            Ok(())
        } else {
            Err(CONSENT_REQUIRED.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;
    use tempfile::tempdir;

    fn grant_now(consent: &PrivateToolsConsent) -> Result<bool, String> {
        consent.grant(consent.generation())
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    #[test]
    fn a_denied_profile_has_no_grant_time() {
        let dir = tempdir().unwrap();
        assert_eq!(
            PrivateToolsConsent::load(dir.path()).granted_since_ms(),
            None
        );
    }

    #[test]
    fn a_grant_is_dated_when_it_was_written() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        let before = now_ms();
        grant_now(&consent).unwrap();
        let after = now_ms();

        let since = consent.granted_since_ms().expect("a grant has a time");
        // File times may be coarser than the clock: allow two seconds.
        assert!(
            since + 2_000 >= before && since <= after + 2_000,
            "{before} <= {since} <= {after}"
        );
        // The next launch reads the same time from the marker.
        assert_eq!(
            PrivateToolsConsent::load(dir.path()).granted_since_ms(),
            Some(since)
        );
    }

    #[test]
    fn a_revoked_grant_has_no_time() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        grant_now(&consent).unwrap();
        consent.revoke().unwrap();
        assert_eq!(consent.granted_since_ms(), None);
    }

    #[test]
    fn defaults_to_denied_on_a_fresh_profile() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        assert!(!consent.is_granted());
        assert_eq!(consent.require().unwrap_err(), CONSENT_REQUIRED);
    }

    #[test]
    fn grant_persists_across_a_restart() {
        let dir = tempdir().unwrap();
        grant_now(&PrivateToolsConsent::load(dir.path())).unwrap();

        // A second load models the next app launch.
        let reloaded = PrivateToolsConsent::load(dir.path());
        assert!(reloaded.is_granted());
        assert!(reloaded.require().is_ok());
    }

    #[test]
    fn revoke_persists_and_is_idempotent() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        grant_now(&consent).unwrap();
        consent.revoke().unwrap();
        assert!(!consent.is_granted());
        // Revoking again must not error just because the marker is already gone.
        consent.revoke().unwrap();

        assert!(!PrivateToolsConsent::load(dir.path()).is_granted());
    }

    #[test]
    fn a_revoke_that_cannot_remove_the_marker_overwrites_it() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        grant_now(&consent).unwrap();
        // Model a marker that cannot be removed (held open by another process).
        consent
            .revoke_with(|_| Err(std::io::Error::other("locked")))
            .unwrap();
        assert!(!consent.is_granted());
        assert!(!PrivateToolsConsent::load(dir.path()).is_granted());
    }

    #[test]
    fn a_revoke_that_cannot_persist_fails_closed_in_memory() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        grant_now(&consent).unwrap();
        // The consent path becomes a directory: neither removing it as a file
        // nor overwriting it can succeed.
        let path = dir.path().join(CONSENT_FILE);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();

        assert_eq!(consent.revoke().unwrap_err(), CONSENT_PERSIST_FAILED);
        assert!(!consent.is_granted());
        assert_eq!(consent.require().unwrap_err(), CONSENT_REQUIRED);
    }

    #[test]
    fn unexpected_marker_content_reads_as_denied() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(CONSENT_FILE), "true").unwrap();
        assert!(!PrivateToolsConsent::load(dir.path()).is_granted());
    }

    #[test]
    fn a_grant_started_before_a_revoke_cannot_commit_after_it() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        // The dialog opens under this generation...
        let generation = consent.generation();
        // ...the user withdraws while it is still showing...
        consent.revoke().unwrap();
        // ...and then clicks Grant on the stale dialog.
        assert!(!consent.grant(generation).unwrap());

        assert!(!consent.is_granted());
        assert_eq!(consent.require().unwrap_err(), CONSENT_REQUIRED);
        assert!(!dir.path().join(CONSENT_FILE).exists());
        assert!(!PrivateToolsConsent::load(dir.path()).is_granted());
    }

    #[test]
    fn a_revoke_during_a_grant_commit_waits_for_it_and_wins() {
        let dir = tempdir().unwrap();
        let consent = Arc::new(PrivateToolsConsent::load(dir.path()));
        let mut revoker = None;
        let granted = consent
            .grant_with(consent.generation(), || {
                // The marker is on disk; memory is not granted yet.
                let started = Arc::new(Barrier::new(2));
                let handle = {
                    let consent = consent.clone();
                    let started = started.clone();
                    thread::spawn(move || {
                        started.wait();
                        consent.revoke()
                    })
                };
                started.wait();
                thread::sleep(Duration::from_millis(50));
                assert!(
                    !handle.is_finished(),
                    "a revoke must not complete inside a grant commit"
                );
                revoker = Some(handle);
            })
            .unwrap();
        // The grant committed first, so it may report success; the revoke
        // that returns after it is the final word.
        assert!(granted);
        revoker.unwrap().join().unwrap().unwrap();

        assert!(!consent.is_granted());
        assert_eq!(consent.require().unwrap_err(), CONSENT_REQUIRED);
        assert!(!PrivateToolsConsent::load(dir.path()).is_granted());
    }

    #[test]
    fn a_grant_after_a_completed_revoke_starts_from_the_new_generation() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        consent.revoke().unwrap();
        assert!(grant_now(&consent).unwrap());
        assert!(consent.is_granted());
        assert!(PrivateToolsConsent::load(dir.path()).is_granted());
    }
}
