import { useState, type ChangeEvent } from "react";
import { AlertTriangle, FileDown, FileText } from "lucide-react";
import { useCollection } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { now } from "@/lib/time";
import { LabViewHeader } from "./LabViewHeader";
import type { LabViewProps } from "./labViews";
import {
  DEFAULT_REPORT_OPTIONS,
  buildEngagementReport,
  reportWords,
  type BuiltReport,
  type ReportOptions,
} from "./reportBuild";
import { useExportReport } from "./useExportReport";

/**
 * Rapor: what the report will say, the button that saves it into
 * the investigation's folder, and the reports saved so far. It replaces the
 * report action that sat at the end of the sub-bar and the Overview's panel.
 * What the report holds and masks is chosen here, and the file is
 * built the way the preview is.
 */
export function LabReport({ engagement }: LabViewProps) {
  const { t, locale } = useT();
  const findings = useCollection("findings");
  const evidence = useCollection("evidence");
  const reports = useCollection("reports");
  const exportEngagement = useExportReport();
  const [options, setOptions] = useState<ReportOptions>(DEFAULT_REPORT_OPTIONS);

  if (!engagement) return <p className="lab-empty-note">{t("lab.empty")}</p>;

  const report = buildEngagementReport({
    engagement,
    findings,
    evidence,
    options,
    words: reportWords(t),
    now: now(),
  });
  const saved = reports
    .filter((r) => r.engagementId === engagement.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const when = (ts: number) =>
    new Date(ts).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  const toggle = (key: keyof ReportOptions) => (e: ChangeEvent<HTMLInputElement>) =>
    setOptions({ ...options, [key]: e.target.checked });

  return (
    <div className="lab-view-stack">
      <LabViewHeader
        icon={FileText}
        title={t("lab.view.report")}
        purpose={t("lab.report.hint")}
        action={
          <button
            type="button"
            className="btn btn--primary btn--sm"
            data-guide="lab-report"
            onClick={() => exportEngagement(engagement, options)}
          >
            <FileDown size={14} aria-hidden /> {t("lab.report.exportMarkdown")}
          </button>
        }
      />
      <section className="lab-panel">
        <fieldset className="lab-panel__b lab-report__options">
          <legend className="lab-panel__t">{t("lab.report.options")}</legend>
          <label className="lab-check">
            <input
              type="checkbox"
              checked={options.includeDismissed}
              onChange={toggle("includeDismissed")}
            />
            {t("lab.report.includeDismissed")}
          </label>
          <label className="lab-check">
            <input type="checkbox" checked={options.mask} onChange={toggle("mask")} />
            {t("lab.report.mask")}
          </label>
          {!options.mask && (
            <p className="lab-fcard__note is-warn">
              <AlertTriangle size={13} aria-hidden /> {t("lab.report.maskOff")}
            </p>
          )}
          <ReportStatus report={report} />
        </fieldset>
      </section>
      <section className="lab-panel" aria-labelledby="lab-report-saved">
        <header className="lab-panel__h">
          <h2 id="lab-report-saved" className="lab-panel__t">
            {t("lab.report.previous")}
          </h2>
        </header>
        {saved.length === 0 ? (
          <p className="lab-panel__b lab-panel__empty">{t("lab.report.none")}</p>
        ) : (
          <ul className="lab-panel__b lab-report__saved">
            {saved.map((r) => (
              <li key={r.id}>
                <span>{when(r.createdAt)}</span>
                {r.sha256 && <code title={r.sha256}>SHA-256 {r.sha256.slice(0, 12)}…</code>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="lab-panel" aria-labelledby="lab-report-preview">
        <header className="lab-panel__h">
          <h2 id="lab-report-preview" className="lab-panel__t">
            {t("lab.report.preview")}
          </h2>
        </header>
        <pre className="lab-panel__b lab-report__preview" data-testid="lab-report-preview">
          {report.markdown}
        </pre>
      </section>
    </div>
  );
}

/** What the report holds, what it leaves out and what it masks. */
function ReportStatus({ report }: { report: BuiltReport }) {
  const { t } = useT();
  const left = [
    report.left.drafts > 0 && t("lab.report.leftDrafts", { count: report.left.drafts }),
    report.left.dismissed > 0 && t("lab.report.leftDismissed", { count: report.left.dismissed }),
  ].filter(Boolean);
  const masked = [
    report.masked.locations > 0 && t("lab.report.maskedLocations", { count: report.masked.locations }),
    report.masked.paths > 0 && t("lab.report.maskedPaths", { count: report.masked.paths }),
    report.masked.sensitive > 0 && t("lab.report.maskedSensitive", { count: report.masked.sensitive }),
  ].filter(Boolean);
  return (
    <div className="lab-report__status" role="status">
      <p>{t("lab.report.holds", { count: report.included.length })}</p>
      {left.length > 0 && <p>{t("lab.report.left", { list: left.join(", ") })}</p>}
      {masked.length > 0 && <p>{t("lab.report.masked", { list: masked.join(", ") })}</p>}
    </div>
  );
}
