import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, FolderCog, Terminal, Wrench } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { useT } from "@/lib/i18n";

/* ============================================================
   Shown wherever the Security Lab needs a native tool supervisor that this
   build cannot provide (browser/demo mode).

   Previously each surface rendered a small bordered box that said only "this
   needs the desktop app" — a dead end. The user is told what is missing and
   given nothing to do about it, which is the worst kind of empty state: it
   reads as a broken feature rather than a boundary.

   The boundary itself stays honest — browser mode still never simulates a run.
   What changes is that the dead end now offers the three routes that actually
   exist from here: the offline utilities that do work in this build, how to get
   a build where native execution is real, and the reference adapter to try
   first once you have one.

   No developer command is printed here: end users never run the app from
   source, so the desktop card only says to open the desktop app.

   Rendered by both the Tools view and the Runs view so the two cannot drift.
   ============================================================ */

/** Path is relative to the repo root — kept in one place so the i18n hint and
    this CTA cannot disagree about which fixture to build. */
const FIXTURE_PATH = "src-tauri/fixtures/contextos_fixture.rs";

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied or unavailable (insecure context,
      // permissions policy). The value is already visible on screen, so a
      // failed copy is a non-event — never surface it as an error.
    }
  };

  return (
    <button type="button" className="btn btn--sm" onClick={copy} aria-label={label}>
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      {copied ? t("lab.tools.unavailableCopied") : t("lab.tools.unavailableCopy")}
    </button>
  );
}

export function NativeToolsUnavailable() {
  const { t } = useT();

  return (
    <section
      className="lab-native-unavailable"
      data-testid="native-tools-unavailable"
    >
      <EmptyState
        icon={FolderCog}
        title={t("lab.tools.desktopRequired")}
        hint={t("lab.tools.desktopRequiredHint")}
      />

      <ul className="lab-native-cta-grid">
        <li className="lab-native-cta">
          <Wrench size={18} aria-hidden />
          <h3>{t("lab.tools.unavailableOfflineTitle")}</h3>
          <p>{t("lab.tools.unavailableOfflineBody")}</p>
          <Link className="btn btn--primary btn--sm" to="/tools">
            {t("lab.tools.openOfflineTools")}
          </Link>
        </li>

        <li className="lab-native-cta">
          <Terminal size={18} aria-hidden />
          <h3>{t("lab.tools.unavailableDesktopTitle")}</h3>
          <p>{t("lab.tools.unavailableDesktopBody")}</p>
        </li>

        <li className="lab-native-cta">
          <FolderCog size={18} aria-hidden />
          <h3>{t("lab.tools.unavailableFixtureTitle")}</h3>
          <ol className="lab-native-cta-steps">
            <li>{t("lab.tools.unavailableFixtureStep1")}</li>
            <li>{t("lab.tools.unavailableFixtureStep2")}</li>
            <li>{t("lab.tools.unavailableFixtureStep3")}</li>
          </ol>
          <code className="lab-native-cta-code">{FIXTURE_PATH}</code>
          <CopyButton
            value={FIXTURE_PATH}
            label={t("lab.tools.unavailableCopyFixture")}
          />
        </li>
      </ul>
    </section>
  );
}
