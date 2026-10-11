import { useState, type FormEvent } from "react";
import { useT } from "./i18n";
import type { BuiltinKey } from "./i18n";
import { Field } from "@/components/ui/Field";
import { builtinTools, type CheckLevel, type HttpReport } from "@/lib/builtinTools";
import {
  Destination,
  DesktopOnly,
  ErrorNote,
  ResultActions,
  RunButton,
  ScopeLine,
  useRequest,
  useScopeGate,
} from "./shared";
import { COOKIE_ISSUES, HTTP_CHECKS, HTTP_NOTES, httpText, wordOr } from "./summaries";

/* HTTP security analyzer. Its result reads as a scorecard: one bar with the
   share of problems, warnings and passes, then every check in that order,
   each with what the header said and what it means. */

const ORDER: CheckLevel[] = ["fail", "warn", "pass", "info"];
const CORS_ORIGIN = "https://cors-check.invalid";

function Scorecard({ report }: { report: HttpReport }) {
  const { t } = useT();
  const total = ORDER.reduce((sum, level) => sum + report.counts[level], 0) || 1;
  return (
    <div className="bt-score">
      <div className="bt-score__bar" role="img" aria-label={t("builtin.http.scoreAria", { fail: report.counts.fail, warn: report.counts.warn, pass: report.counts.pass })}>
        {ORDER.map((level) =>
          report.counts[level] > 0 ? (
            <span key={level} className={`bt-score__seg is-${level}`} style={{ flexGrow: report.counts[level] / total }} />
          ) : null,
        )}
      </div>
      <dl className="bt-score__legend">
        {ORDER.map((level) => (
          <div key={level} className={`is-${level}`}>
            <dt>{t(`builtin.level.${level}` as BuiltinKey)}</dt>
            <dd>{report.counts[level]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function HttpResult({ report }: { report: HttpReport }) {
  const { t } = useT();
  const checks = [...report.checks].sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));
  return (
    <div className="bt-result">
      <p className="bt-status-line">
        <span className={`bt-status-code is-${Math.floor(report.status / 100)}xx`}>{report.status}</span>
        <span className="mono bt-break">{report.finalUrl}</span>
      </p>
      {report.hops.length > 1 && (
        <ol className="bt-hops" aria-label={t("builtin.http.redirects")}>
          {report.hops.map((hop, i) => (
            <li key={`${hop.url}-${i}`}>
              <span className="bt-status-code">{hop.status}</span> <span className="mono bt-break">{hop.url}</span>
            </li>
          ))}
        </ol>
      )}
      {report.stopped && (
        <p className="bt-note bt-note--warn">
          {t(`builtin.http.stop.${report.stopped[1]}` as BuiltinKey)} <span className="mono bt-break">{report.stopped[0]}</span>
        </p>
      )}

      <Scorecard report={report} />

      <ul className="bt-checks">
        {checks.map((check) => (
          <li key={check.id} className={`bt-check is-${check.level}`}>
            <span className="bt-check__level">{t(`builtin.level.${check.level}` as BuiltinKey)}</span>
            <div className="bt-check__body">
              <strong>{wordOr(t, "builtin.http.check", check.id, HTTP_CHECKS)}</strong>
              {check.notes.length > 0 && (
                <p>{check.notes.map((n) => wordOr(t, "builtin.http.note", n, HTTP_NOTES)).join(" ")}</p>
              )}
              {check.value && <code className="bt-check__value">{check.value}</code>}
            </div>
          </li>
        ))}
      </ul>

      {report.cookies.length > 0 && (
        <section>
          <h3 className="bt-h3">{t("builtin.http.cookies", { count: report.cookies.length })}</h3>
          <div className="table-wrap bt-table-wrap">
            <table className="table bt-table">
              <thead>
                <tr>
                  <th>{t("builtin.http.cookieName")}</th>
                  {/* Attribute names, not words: never upper-cased the Turkish way. */}
                  <th lang="en">Secure</th>
                  <th lang="en">HttpOnly</th>
                  <th lang="en">SameSite</th>
                  <th>{t("builtin.http.cookieIssues")}</th>
                </tr>
              </thead>
              <tbody>
                {report.cookies.map((cookie, i) => (
                  <tr key={`${cookie.name}-${i}`}>
                    <td className="mono">{cookie.name}</td>
                    <td>{cookie.secure ? "✓" : "—"}</td>
                    <td>{cookie.httpOnly ? "✓" : "—"}</td>
                    <td>{cookie.sameSite ?? "—"}</td>
                    <td className={cookie.issues.length ? "bt-bad" : "bt-good"}>
                      {cookie.issues.length
                        ? cookie.issues.map((issue) => wordOr(t, "builtin.http.cookie", issue, COOKIE_ISSUES)).join(", ")
                        : t("builtin.http.cookieOk")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report.cspDirectives.length > 0 && (
        <details className="bt-details">
          <summary>{t("builtin.http.cspDirectives", { count: report.cspDirectives.length })}</summary>
          <dl className="bt-facts bt-facts--mono">
            {report.cspDirectives.map(([name, value]) => (
              <div key={name} className="bt-fact">
                <dt>{name}</dt>
                <dd className="mono">{value || "—"}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <details className="bt-details">
        <summary>{t("builtin.http.rawHeaders", { count: report.headers.length })}</summary>
        <pre className="bt-pre">{report.headers.map(([k, v]) => `${k}: ${v}`).join("\n")}</pre>
      </details>
    </div>
  );
}

export function HttpTool() {
  const { t } = useT();
  const gate = useScopeGate();
  const [target, setTarget] = useState("");
  const request = useRequest<HttpReport>("http");
  const [blocked, setBlocked] = useState<string | null>(null);
  const available = builtinTools.available();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const verdict = gate.decide(target);
    if (!verdict.ok) {
      setBlocked(verdict.decision ? "scope_blocked" : "target_empty");
      return;
    }
    setBlocked(null);
    void request.run((id) => builtinTools.http(id, target.trim(), verdict.attestation));
  };

  const state = request.state;
  return (
    <div className="bt-tool bt-http">
      <form className="bt-form" onSubmit={submit}>
        <Destination>
          {t("builtin.http.dest", { origin: CORS_ORIGIN })}
        </Destination>
        <div className="bt-form__row">
          <Field label={t("builtin.http.target")} className="bt-grow">
            {(id) => (
              <input
                id={id}
                className="input mono"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="https://example.com/"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <RunButton
            running={state.phase === "running"}
            since={state.phase === "running" ? state.since : undefined}
            label={t("builtin.http.run")}
            disabled={!available || !target.trim()}
            onCancel={request.cancel}
          />
        </div>
        <ScopeLine gate={gate} target={target} />
      </form>
      {!available && <DesktopOnly />}
      {blocked && <ErrorNote error={blocked} />}
      {state.phase === "error" && <ErrorNote error={state.error} />}
      {state.phase === "idle" && available && !blocked && <p className="bt-empty">{t("builtin.http.empty")}</p>}
      {state.phase === "done" && (
        <>
          <HttpResult report={state.result} />
          <ResultActions
            tool="http"
            target={state.result.finalUrl}
            text={httpText(t, state.result)}
            data={state.result}
            title={`HTTP · ${state.result.finalUrl}`}
            engagementId={gate.engagement?.id}
          />
        </>
      )}
    </div>
  );
}
