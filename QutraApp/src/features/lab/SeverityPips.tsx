import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { SEVERITY_ORDER, totalOf, type SeverityCounts } from "./investigationFacts";
import "./severityPips.css";

/** Open findings at a glance: one small count per severity that has any,
    most severe first, each in its severity's colour and named in words for
    screen readers. A dash when nothing is open. */
export function SeverityPips({ counts }: { counts: SeverityCounts | undefined }) {
  const { t } = useT();
  if (!counts || totalOf(counts) === 0) {
    return (
      <span className="sev-pips sev-pips--none">
        <span aria-hidden>—</span>
        <span className="sr-only">{t("home.recent.noOpenFindings")}</span>
      </span>
    );
  }
  const shown = SEVERITY_ORDER.filter((s) => counts[s] > 0);
  const label = (s: (typeof SEVERITY_ORDER)[number]) => t(`lab.severity.${s}` as MessageKey);
  const words = shown.map((s) => `${counts[s]} ${label(s)}`).join(", ");
  return (
    <span className="sev-pips" title={words}>
      {shown.map((s) => (
        <span key={s} className={`sev-pip sev-pip--${s}`} aria-hidden>
          {counts[s]}
        </span>
      ))}
      <span className="sr-only">{t("home.recent.openFindings", { list: words })}</span>
    </span>
  );
}
