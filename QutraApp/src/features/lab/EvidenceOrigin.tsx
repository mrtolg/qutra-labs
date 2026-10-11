import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileSearch } from "lucide-react";
import type { Evidence } from "@/domain/findings";
import { analysis } from "@/lib/analysis";
import { externalTools } from "@/lib/externalTools";
import { sha256Hex } from "@/lib/hash";
import { useT } from "@/lib/i18n";
import { STEP_NAMES, own } from "./analysisLabels";

/* Where one piece of evidence came from (spec 2026-10-07 §4.6):
   the chain finding → evidence → run → raw output. For an observation of a
   built-in analysis or of a program outside Qutra Labs, the raw
   output can be opened and its SHA-256 compared with the one kept when the
   evidence was pinned. */

/** "tampered": Rust holds a hash of the log and the log on disk no longer
    matches it, so it is not handed out. */
type Raw =
  | { text: string; verdict: "matches" | "changed" | "unknown" }
  | "failed"
  | "tampered"
  | "consent";

export function EvidenceOrigin({ evidence }: { evidence: Evidence }) {
  const { t, locale } = useT();
  const [raw, setRaw] = useState<Raw | null>(null);
  const [busy, setBusy] = useState(false);
  const when = new Date(evidence.capturedAt).toLocaleString(locale, {
    dateStyle: "short",
    timeStyle: "short",
  });
  const analyzer = evidence.source.replace(/^(analysis|tool):/, "");
  const stepKey = own(STEP_NAMES, analyzer);
  const step = stepKey ? t(stepKey) : analyzer;
  const line =
    evidence.kind === "observation"
      ? t(evidence.source.startsWith("tool:") ? "lab.insp.source.tool" : "lab.insp.source.analysis", {
          step,
          time: when,
        })
      : evidence.source.startsWith("run:")
        ? t("lab.insp.source.run", { time: when })
        : evidence.source.startsWith("import:")
          ? t("lab.insp.source.import", { time: when })
          : evidence.source === "manual"
            ? t("lab.insp.source.manual")
            : null;
  const runId = evidence.kind === "observation" ? evidence.runId : undefined;
  const outside = Boolean(runId?.startsWith("run-"));
  const canOpen =
    (Boolean(runId?.startsWith("ana-")) && analysis.available()) ||
    (outside && externalTools.available());

  /** Read the raw output now and check it against the hash kept with the evidence. */
  const toggle = async () => {
    if (busy) return;
    if (raw) {
      setRaw(null);
      return;
    }
    setBusy(true);
    try {
      const text = outside ? await externalTools.output(runId!) : await analysis.output(runId!);
      const kept = evidence.rawRef?.sha256;
      const verdict = !kept ? "unknown" : (await sha256Hex(text)) === kept ? "matches" : "changed";
      setRaw({ text, verdict });
    } catch (caught) {
      setRaw(
        caught === "output_changed"
          ? "tampered"
          : caught === "private_tools_consent_required"
            ? "consent"
            : "failed",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!line && !canOpen) return null;
  return (
    <div className="lab-origin">
      {line && <p className="lab-origin__line">{line}</p>}
      {canOpen && (
        <>
          <button
            type="button"
            className="btn btn--ghost btn--sm lab-origin__open"
            aria-expanded={raw !== null}
            aria-disabled={busy || undefined}
            onClick={() => void toggle()}
          >
            <FileSearch size={13} aria-hidden />{" "}
            {raw ? t("lab.insp.hideRaw") : t("lab.insp.openRaw")}
          </button>
          <div role="status">
            {raw === "tampered" ? (
              <p className="lab-fcard__note is-warn">
                <AlertTriangle size={13} aria-hidden /> {t("lab.analysis.outputChanged")}
              </p>
            ) : raw === "consent" ? (
              <p className="lab-fcard__note is-warn">
                <AlertTriangle size={13} aria-hidden /> {t("lab.analysis.error.consent")}
              </p>
            ) : raw === "failed" ? (
              <p className="lab-fcard__note is-warn">
                <AlertTriangle size={13} aria-hidden /> {t("lab.analysis.outputMissing")}
              </p>
            ) : raw?.verdict === "matches" ? (
              <p className="lab-fcard__note is-ok">
                <CheckCircle2 size={13} aria-hidden /> {t("lab.insp.rawMatches")}
              </p>
            ) : raw?.verdict === "changed" ? (
              <p className="lab-fcard__note is-warn">
                <AlertTriangle size={13} aria-hidden /> {t("lab.insp.rawChanged")}
              </p>
            ) : raw?.verdict === "unknown" ? (
              <p className="lab-fcard__note">{t("lab.insp.rawUnchecked")}</p>
            ) : null}
          </div>
          {raw && typeof raw === "object" && <pre className="lab-origin__raw">{raw.text}</pre>}
        </>
      )}
    </div>
  );
}
