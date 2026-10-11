import { useState } from "react";
import { ExternalLink, FolderOpen, PackageCheck, PackageSearch } from "lucide-react";
import { useT } from "./i18n";
import type { BuiltinKey } from "./i18n";
import { getBridge } from "@/lib/bridge";
import { builtinTools, type Advisory, type OsvReport, type PickedManifests } from "@/lib/builtinTools";
import { Destination, DesktopOnly, ErrorNote, ResultActions, RunButton, useRequest } from "./shared";
import { SEVERITIES, osvText, wordOr } from "./summaries";

/* Dependency and CVE center, in two steps the user sees: pick the manifests
   (read here, nothing sent), then check the listed package names and
   versions against OSV.dev. Its result reads as a ledger: how many known
   vulnerabilities at each severity, then each affected package with its
   advisories and the version that fixes them. */

const RANK: Record<string, number> = { critical: 0, high: 1, moderate: 2, medium: 2, low: 3 };
const FORMATS = "package-lock.json · package.json · yarn.lock · requirements*.txt · Pipfile.lock · poetry.lock · Cargo.lock · composer.lock · Gemfile.lock · go.mod";

function worst(ids: string[], byId: Map<string, Advisory>): number {
  return Math.min(4, ...ids.map((id) => RANK[byId.get(id)?.severity ?? ""] ?? 4));
}

function Ledger({ report }: { report: OsvReport }) {
  const { t } = useT();
  const byId = new Map(report.advisories.map((a) => [a.id, a]));
  const tally: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const a of report.advisories) {
    const sev = a.severity === "moderate" ? "medium" : a.severity;
    tally[sev in tally ? sev : "unknown"] += 1;
  }
  const findings = [...report.findings].sort((a, b) => worst(a.ids, byId) - worst(b.ids, byId));

  if (findings.length === 0) {
    return (
      <p className="bt-note bt-note--ok">
        <PackageCheck size={14} aria-hidden /> {t("builtin.deps.clean")} {t("builtin.deps.checkedCount", { count: report.checked })}
      </p>
    );
  }
  return (
    <div className="bt-result">
      <dl className="bt-ledger">
        {(["critical", "high", "medium", "low", "unknown"] as const).map((sev) => (
          <div key={sev} className={`is-${sev}`}>
            <dd>{tally[sev]}</dd>
            <dt>{t(`builtin.deps.sev.${sev}` as BuiltinKey)}</dt>
          </div>
        ))}
      </dl>
      <p className="bt-summary-line">
        {t("builtin.deps.summary", { affected: report.findings.length, checked: report.checked })}
        {report.advisoriesCut && ` ${t("builtin.deps.cut")}`}
      </p>
      <ul className="bt-packages">
        {findings.map((finding) => (
          <li key={`${finding.package.ecosystem}:${finding.package.name}@${finding.package.version}`} className="bt-package">
            <header>
              <span className="bt-chip">{finding.package.ecosystem}</span>
              <strong className="mono">{finding.package.name}</strong>
              <span className="mono faint">{finding.package.version}</span>
            </header>
            <ul className="bt-advisories">
              {finding.ids.map((id) => {
                const a = byId.get(id);
                const fixed = a?.fixed[finding.package.name];
                const cves = a?.aliases.filter((x) => x.startsWith("CVE-")) ?? [];
                const sev = a?.severity === "moderate" ? "medium" : a?.severity || "unknown";
                return (
                  <li key={id} className={`bt-advisory is-${sev}`}>
                    <span className="bt-advisory__sev">
                      {a?.severity ? wordOr(t, "builtin.deps.sev", a.severity, SEVERITIES) : t("builtin.deps.sev.unknown")}
                      {a?.score !== null && a?.score !== undefined && <span className="mono"> {a.score.toFixed(1)}</span>}
                    </span>
                    <div className="bt-advisory__body">
                      <p>
                        <span className="mono">{id}</span>
                        {cves.length > 0 && <span className="mono faint"> · {cves.join(", ")}</span>}
                      </p>
                      {a?.summary && <p className="bt-advisory__summary">{a.summary}</p>}
                      <p className="bt-advisory__fix">
                        {fixed && fixed.length > 0
                          ? t("builtin.deps.fixedIn", { versions: fixed.join(", ") })
                          : t("builtin.deps.noFix")}
                        {a?.url && (
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void getBridge().openUrl(a.url)}>
                            <ExternalLink size={12} aria-hidden /> {t("builtin.deps.advisory")}
                          </button>
                        )}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DepsTool() {
  const { t } = useT();
  const pickRequest = useRequest<PickedManifests | null>("deps-pick");
  const check = useRequest<OsvReport>("deps");
  const [picked, setPicked] = useState<PickedManifests | null>(null);
  const available = builtinTools.available();

  const pick = () =>
    void pickRequest.run(async () => {
      const result = await builtinTools.depsPick(t("builtin.deps.dialogTitle"));
      if (result) {
        setPicked(result);
        check.reset();
      }
      return result;
    });
  const send = () => {
    if (!picked) return;
    void check.run((id) => builtinTools.depsCheck(id, picked.token));
  };

  const count = picked?.packages.length ?? 0;
  const state = check.state;
  return (
    <div className="bt-tool bt-deps">
      {picked ? (
        <Destination>{t("builtin.deps.dest", { count })}</Destination>
      ) : (
        <Destination local />
      )}

      <ol className="bt-steps">
        <li className={picked ? "is-done" : "is-current"}>
          <span className="bt-steps__n" aria-hidden>1</span>
          <div>
            <p className="bt-steps__title">{t("builtin.deps.step1")}</p>
            <p className="bt-form__hint">{FORMATS}</p>
            <button type="button" className="btn btn--secondary btn--sm" onClick={pick} disabled={!available || pickRequest.state.phase === "running"}>
              <FolderOpen size={13} aria-hidden /> {picked ? t("builtin.deps.pickAgain") : t("builtin.deps.pick")}
            </button>
          </div>
        </li>
        <li className={picked ? (state.phase === "done" ? "is-done" : "is-current") : "is-waiting"}>
          <span className="bt-steps__n" aria-hidden>2</span>
          <div>
            <p className="bt-steps__title">{t("builtin.deps.step2")}</p>
            {picked && (
              <form
                className="bt-inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <RunButton
                  running={state.phase === "running"}
                  since={state.phase === "running" ? state.since : undefined}
                  label={t("builtin.deps.run", { count })}
                  disabled={count === 0}
                  onCancel={check.cancel}
                />
              </form>
            )}
          </div>
        </li>
      </ol>

      {!available && <DesktopOnly />}
      {pickRequest.state.phase === "error" && <ErrorNote error={pickRequest.state.error} />}

      {picked && (
        <section className="bt-manifests">
          <ul className="bt-files">
            {picked.files.map((file, i) => (
              <li key={`${file.name}-${i}`} className={file.error ? "is-error" : undefined}>
                <strong className="mono">{file.name}</strong>
                {file.error ? (
                  <span>{t(`builtin.deps.fileError.${file.error === "unknown_format" || file.error === "bad_manifest" || file.error === "too_large" ? file.error : "unreadable"}` as BuiltinKey)}</span>
                ) : (
                  <span>
                    {t("builtin.deps.fileCount", { count: file.packages })}
                    {file.skipped > 0 && ` · ${t("builtin.deps.skipped", { count: file.skipped })}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {count > 0 && (
            <details className="bt-details">
              <summary>
                <PackageSearch size={13} aria-hidden /> {t("builtin.deps.toSend", { count })}{" "}
                <span className="faint">
                  {Object.entries(picked.ecosystems)
                    .map(([eco, n]) => `${eco} ${n}`)
                    .join(" · ")}
                </span>
              </summary>
              <ul className="bt-tags mono">
                {picked.packages.slice(0, 600).map((p) => (
                  <li key={`${p.ecosystem}:${p.name}@${p.version}`}>
                    {p.ecosystem} {p.name}@{p.version}
                  </li>
                ))}
                {picked.packages.length > 600 && <li>… +{picked.packages.length - 600}</li>}
              </ul>
            </details>
          )}
          {count === 0 && <p className="bt-note bt-note--quiet">{t("builtin.deps.nothingToSend")}</p>}
        </section>
      )}

      {!picked && available && pickRequest.state.phase !== "running" && <p className="bt-empty">{t("builtin.deps.empty")}</p>}
      {state.phase === "error" && <ErrorNote error={state.error} />}
      {state.phase === "done" && (
        <>
          <Ledger report={state.result} />
          <ResultActions
            tool="deps"
            target={picked?.files.map((f) => f.name).join("-") ?? ""}
            text={osvText(t, state.result)}
            data={state.result}
            title={t("builtin.deps.evidenceTitle", { count: state.result.findings.length })}
          />
        </>
      )}
    </div>
  );
}
