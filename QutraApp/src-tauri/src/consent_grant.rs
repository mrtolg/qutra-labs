//! Native Private Lab grant confirmation (TM-001, ADR 0014).
//!
//! The renderer may ask for a grant and may pass a locale code. It cannot
//! pass the words on the dialog, and it cannot turn consent on by sending a
//! boolean. Revoke needs no dialog: it is the safe direction.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::consent::PrivateToolsConsent;

const COOLDOWN: Duration = Duration::from_secs(10);

pub struct DialogCopy {
    pub title: &'static str,
    pub body: &'static str,
    pub grant: &'static str,
    pub cancel: &'static str,
}

/// Unknown codes fall back to English. The renderer chooses the language only.
pub fn dialog_copy(locale: &str) -> DialogCopy {
    match locale {
        "tr" => DialogCopy {
            title: "Özel Laboratuvar",
            body: "Terminal, kayıtlı araçların başlatılması ve asistanın önerileri kullanılabilir olur. Terminal komutları ve araç başlatmaları her seferinde sorulur. Bunlar Windows hesabınızın tüm izinleriyle çalışır. Bunu Ayarlar'dan kapatabilirsiniz.",
            grant: "Onayla",
            cancel: "İptal",
        },
        "de" => DialogCopy {
            title: "Privates Labor",
            body: "Das Terminal, Starts registrierter Werkzeuge und die Vorschläge des Assistenten werden verfügbar. Terminalbefehle und Werkzeugstarts fragen jedes Mal nach. Sie laufen mit den vollen Rechten Ihres Windows-Kontos. Sie können dies in den Einstellungen ausschalten.",
            grant: "Zulassen",
            cancel: "Abbrechen",
        },
        "fr" => DialogCopy {
            title: "Laboratoire privé",
            body: "Le terminal, les lancements d'outils enregistrés et les propositions de l'assistant deviennent disponibles. Les commandes du terminal et les lancements d'outils demandent encore confirmation à chaque fois. Ils s'exécutent avec toutes les autorisations de votre compte Windows. Vous pouvez le désactiver dans les paramètres.",
            grant: "Autoriser",
            cancel: "Annuler",
        },
        "es" => DialogCopy {
            title: "Laboratorio privado",
            body: "El terminal, los lanzamientos de herramientas registradas y las propuestas del asistente quedan disponibles. Los comandos del terminal y los lanzamientos de herramientas siguen pidiendo confirmación cada vez. Se ejecutan con todos los permisos de su cuenta de Windows. Puede desactivarlo en Ajustes.",
            grant: "Permitir",
            cancel: "Cancelar",
        },
        "it" => DialogCopy {
            title: "Laboratorio privato",
            body: "Il terminale, gli avvii degli strumenti registrati e le proposte dell'assistente diventano disponibili. I comandi del terminale e gli avvii degli strumenti chiedono ancora conferma ogni volta. Vengono eseguiti con tutte le autorizzazioni del suo account Windows. Può disattivarlo in Impostazioni.",
            grant: "Consenti",
            cancel: "Annulla",
        },
        _ => DialogCopy {
            title: "Private Lab",
            body: "The terminal, launches of registered tools, and the assistant's proposals become available. Terminal commands and tool launches still ask each time. They run with your full Windows account permissions. You can turn this off in Settings.",
            grant: "Grant",
            cancel: "Cancel",
        },
    }
}

/// One dialog at a time, then a short cooldown after a decline.
pub struct GrantSession {
    /// Open and cooldown change together under one lock, so a request can
    /// never see the dialog closed before its decline cooldown is in place.
    state: Mutex<DialogState>,
    /// Read at each transition rather than passed in, so the cooldown always
    /// runs from the moment the user answered, however long the dialog sat open.
    clock: Box<dyn Fn() -> Instant + Send + Sync>,
}

#[derive(Default)]
struct DialogState {
    open: bool,
    cooldown_until: Option<Instant>,
}

impl GrantSession {
    pub fn new() -> Self {
        Self::with_clock(Instant::now)
    }

    fn with_clock(clock: impl Fn() -> Instant + Send + Sync + 'static) -> Self {
        Self {
            state: Mutex::new(DialogState::default()),
            clock: Box::new(clock),
        }
    }

    /// `confirm` runs only when a dialog is actually needed. `Ok(false)` is a
    /// decline. `Err` is `consent_dialog_open` or `consent_dialog_cooldown`.
    #[cfg(test)]
    pub fn request(
        &self,
        already_granted: bool,
        confirm: impl FnOnce() -> bool,
    ) -> Result<bool, &'static str> {
        if already_granted {
            return Ok(true);
        }
        self.try_begin()?;
        let confirmed = confirm();
        self.finish(confirmed);
        Ok(confirmed)
    }

    /// Mark a dialog open, or refuse because one is open or the cooldown has
    /// not elapsed. The async command calls this before `show`, then `finish`
    /// after the oneshot resolves, so the dialog await is not inside this lock.
    pub fn try_begin(&self) -> Result<(), &'static str> {
        let mut state = self.state_lock();
        if state.open {
            return Err("consent_dialog_open");
        }
        let now = (self.clock)();
        if state.cooldown_until.is_some_and(|until| now < until) {
            return Err("consent_dialog_cooldown");
        }
        state.open = true;
        Ok(())
    }

    /// Clear the open flag without a cooldown. Used when the dialog never opened.
    pub fn cancel_open(&self) {
        self.state_lock().open = false;
    }

    /// Close the dialog; a decline cools down from now, the moment of answer.
    pub fn finish(&self, confirmed: bool) {
        let mut state = self.state_lock();
        state.open = false;
        if !confirmed {
            state.cooldown_until = Some((self.clock)() + COOLDOWN);
        }
    }

    fn state_lock(&self) -> std::sync::MutexGuard<'_, DialogState> {
        match self.state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl Default for GrantSession {
    fn default() -> Self {
        Self::new()
    }
}

/// Persist only a confirmation. A decline writes nothing, and so does a
/// confirmation of a dialog that a revoke has overtaken since `generation`.
pub fn apply_confirmed(
    consent: &PrivateToolsConsent,
    generation: u64,
    confirmed: bool,
) -> Result<bool, String> {
    if !confirmed {
        return Ok(false);
    }
    consent.grant(generation)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;
    use tempfile::tempdir;

    #[test]
    fn already_granted_never_calls_confirm() {
        let session = GrantSession::new();
        let mut called = false;
        let answer = session
            .request(true, || {
                called = true;
                false
            })
            .unwrap();
        assert!(answer);
        assert!(!called);
    }

    #[test]
    fn declined_leaves_consent_denied_and_writes_no_file() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        let session = GrantSession::new();
        let generation = consent.generation();
        let confirmed = session.request(false, || false).unwrap();
        assert!(!apply_confirmed(&consent, generation, confirmed).unwrap());
        assert!(!consent.is_granted());
        let reloaded = PrivateToolsConsent::load(dir.path());
        assert!(!reloaded.is_granted());
    }

    #[test]
    fn confirmed_grants_and_persists() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        let session = GrantSession::new();
        let generation = consent.generation();
        let confirmed = session.request(false, || true).unwrap();
        assert!(apply_confirmed(&consent, generation, confirmed).unwrap());
        assert!(PrivateToolsConsent::load(dir.path()).is_granted());
    }

    #[test]
    fn a_confirmation_that_lands_after_a_revoke_is_not_acknowledged() {
        let dir = tempdir().unwrap();
        let consent = PrivateToolsConsent::load(dir.path());
        let session = GrantSession::new();
        let generation = consent.generation();
        let confirmed = session
            .request(false, || {
                // Withdrawn from Settings while the dialog is still showing.
                consent.revoke().unwrap();
                true
            })
            .unwrap();
        assert!(!apply_confirmed(&consent, generation, confirmed).unwrap());
        assert!(!consent.is_granted());
        assert!(!PrivateToolsConsent::load(dir.path()).is_granted());
    }

    /// A session whose clock only moves when the test says so.
    fn clocked() -> (GrantSession, impl Fn(u64)) {
        let now = Arc::new(Mutex::new(Instant::now()));
        let read = now.clone();
        let session = GrantSession::with_clock(move || *read.lock().unwrap());
        let advance = move |secs| *now.lock().unwrap() += Duration::from_secs(secs);
        (session, advance)
    }

    #[test]
    fn a_decline_after_a_long_dialog_cools_down_from_the_decline() {
        let (session, advance) = clocked();
        let declined = session.request(false, || {
            // The dialog sits open longer than the cooldown itself.
            advance(11);
            false
        });
        assert_eq!(declined, Ok(false));
        advance(9);
        assert_eq!(
            session.request(false, || true),
            Err("consent_dialog_cooldown")
        );
        advance(1);
        assert_eq!(session.request(false, || true), Ok(true));
    }

    #[test]
    fn a_request_racing_a_decline_never_slips_between_close_and_cooldown() {
        for _ in 0..200 {
            let session = Arc::new(clocked().0);
            session.try_begin().unwrap();
            let start = Arc::new(Barrier::new(2));
            let finisher = {
                let session = session.clone();
                let start = start.clone();
                thread::spawn(move || {
                    start.wait();
                    session.finish(false);
                })
            };
            start.wait();
            let raced = session.try_begin();
            finisher.join().unwrap();
            assert!(
                raced.is_err(),
                "a request got in between close and cooldown"
            );
        }
    }

    #[test]
    fn a_second_request_while_the_dialog_is_open_is_refused() {
        let session = Arc::new(GrantSession::new());
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let worker = {
            let session = session.clone();
            let entered = entered.clone();
            let release = release.clone();
            thread::spawn(move || {
                session.request(false, || {
                    entered.wait();
                    release.wait();
                    true
                })
            })
        };
        entered.wait();
        let second = session.request(false, || true);
        assert_eq!(second, Err("consent_dialog_open"));
        release.wait();
        assert!(worker.join().unwrap().unwrap());
    }

    #[test]
    fn a_decline_starts_a_ten_second_cooldown() {
        let (session, advance) = clocked();
        assert!(!session.request(false, || false).unwrap());
        advance(9);
        assert_eq!(
            session.request(false, || true),
            Err("consent_dialog_cooldown")
        );
        advance(1);
        assert!(session.request(false, || true).unwrap());
    }

    #[test]
    fn an_unknown_locale_uses_english_and_turkish_addresses_siz() {
        let english = dialog_copy("zz");
        assert_eq!(english.grant, "Grant");
        assert!(english.body.contains("your full Windows account"));
        let turkish = dialog_copy("tr");
        assert!(turkish.body.contains("hesabınızın"));
        assert!(!turkish.body.to_lowercase().contains("senin"));
        assert_eq!(turkish.grant, "Onayla");
    }
}
