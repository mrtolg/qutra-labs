import { useState, type FormEvent } from "react";
import { CheckCircle2, ShieldAlert, ShieldCheck } from "lucide-react";
import { useT } from "./i18n";
import { Field } from "@/components/ui/Field";
import { builtinTools, type CertInfo, type TlsReport } from "@/lib/builtinTools";
import {
  Destination,
  DesktopOnly,
  ErrorNote,
  Fact,
  ResultActions,
  RunButton,
  ScopeLine,
  shownDate,
  useRequest,
  useScopeGate,
} from "./shared";
import { TLS_TRUST, TLS_WARNINGS, tlsText, wordOr } from "./summaries";

/* TLS certificate inspector. Its result reads as the chain itself: the
   server's certificate on top, each issuer under it, every link with a bar
   from "valid from" to "valid until" and today marked on it. */

const DAY = 86_400_000;

function ValidityBar({ cert, at }: { cert: CertInfo; at: number }) {
  const { t, locale } = useT();
  const span = Math.max(1, cert.notAfterMs - cert.notBeforeMs);
  const elapsed = Math.min(1, Math.max(0, (at - cert.notBeforeMs) / span));
  const days = Math.floor((cert.notAfterMs - at) / DAY);
  const tone = days < 0 ? "is-expired" : days < 30 ? "is-soon" : "is-ok";
  return (
    <div className={`bt-validity ${tone}`}>
      <div
        className="bt-validity__track"
        role="img"
        aria-label={t("builtin.tls.validityAria", {
          from: shownDate(cert.notBeforeMs, locale),
          to: shownDate(cert.notAfterMs, locale),
        })}
      >
        <span className="bt-validity__used" style={{ width: `${elapsed * 100}%` }} />
        <span className="bt-validity__now" style={{ left: `${elapsed * 100}%` }} />
      </div>
      <div className="bt-validity__ends">
        <span>{shownDate(cert.notBeforeMs, locale)}</span>
        <strong>
          {days < 0 ? t("builtin.tls.expiredAgo", { days: -days }) : t("builtin.tls.daysLeftShort", { days })}
        </strong>
        <span>{shownDate(cert.notAfterMs, locale)}</span>
      </div>
    </div>
  );
}

function ChainLink({ cert, index, at }: { cert: CertInfo; index: number; at: number }) {
  const { t } = useT();
  const [allNames, setAllNames] = useState(false);
  // Servers seldom send their root: only a certificate that signs itself is one.
  const role =
    index === 0 ? t("builtin.tls.role.leaf") : cert.selfSigned ? t("builtin.tls.role.root") : t("builtin.tls.role.intermediate");
  const names = allNames ? cert.san : cert.san.slice(0, 10);
  return (
    <li className="bt-chain__link">
      <span className="bt-chain__node" aria-hidden />
      <div className="bt-chain__card">
        <p className="bt-eyebrow">{role}</p>
        <h4 className="bt-chain__cn">{cert.subjectCn || cert.subject || t("builtin.tls.unnamed")}</h4>
        {cert.unreadable ? (
          <p className="bt-note bt-note--quiet">{t("builtin.tls.unreadable")}</p>
        ) : (
          <>
            <ValidityBar cert={cert} at={at} />
            <dl className="bt-facts bt-facts--grid">
              <Fact label={t("builtin.tls.subject")} value={cert.subject} />
              <Fact label={t("builtin.tls.issuer")} value={cert.issuer} />
              <Fact label={t("builtin.tls.key")} value={`${cert.key}${cert.keyBits ? ` · ${cert.keyBits} bit` : ""}`} />
              <Fact label={t("builtin.tls.signature")} value={cert.signature} />
              <Fact label={t("builtin.tls.serial")} value={cert.serial} mono />
              <Fact label="SHA-256" value={<span className="bt-hash">{cert.sha256}</span>} mono wide />
            </dl>
            {cert.san.length > 0 && (
              <div className="bt-chips" aria-label={t("builtin.tls.names")}>
                {names.map((name) => (
                  <span key={name} className="bt-chip mono">{name}</span>
                ))}
                {cert.san.length > 10 && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAllNames(!allNames)}>
                    {allNames ? t("builtin.showLess") : t("builtin.showMore", { count: cert.san.length - 10 })}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function TlsResult({ report }: { report: TlsReport }) {
  const { t } = useT();
  const warnings = report.warnings.filter((w) => !w.startsWith("untrusted:"));
  return (
    <div className="bt-result">
      <header className={`bt-verdict-head ${report.trusted && report.nameMatches ? "is-ok" : "is-bad"}`}>
        {report.trusted && report.nameMatches ? <ShieldCheck size={22} aria-hidden /> : <ShieldAlert size={22} aria-hidden />}
        <div>
          <p className="bt-verdict-head__title">
            {report.trusted
              ? report.nameMatches
                ? t("builtin.tls.trust.ok")
                : t("builtin.tls.warn.name_mismatch")
              : wordOr(t, "builtin.tls.trust", report.trustError ?? "untrusted", TLS_TRUST)}
          </p>
          <p className="bt-verdict-head__sub mono">
            {report.host}:{report.port} → {report.address}
          </p>
        </div>
      </header>

      <div className="bt-protocols">
        {report.protocols.map((p) => (
          <span key={p.version} className={`bt-proto ${p.supported ? "is-on" : "is-off"}`}>
            <strong>{p.version}</strong>
            <span>{p.supported ? p.cipher ?? t("builtin.tls.supported") : t("builtin.tls.notSupported")}</span>
          </span>
        ))}
        <span className="bt-proto is-unknown">
          <strong>TLS 1.0 / 1.1</strong>
          <span>{t("builtin.tls.oldNotTried")}</span>
        </span>
        {report.alpn && (
          <span className="bt-proto is-on">
            <strong>ALPN</strong>
            <span>{report.alpn}</span>
          </span>
        )}
      </div>

      {warnings.length > 0 ? (
        <ul className="bt-warnings">
          {warnings.map((w) => (
            <li key={w}>
              <ShieldAlert size={13} aria-hidden /> {wordOr(t, "builtin.tls.warn", w, TLS_WARNINGS)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="bt-note bt-note--ok">
          <CheckCircle2 size={14} aria-hidden /> {t("builtin.tls.noWarnings")}
        </p>
      )}

      <section aria-label={t("builtin.tls.chain")}>
        <h3 className="bt-h3">{t("builtin.tls.chainCount", { count: report.chain.length })}</h3>
        <ol className="bt-chain">
          {report.chain.map((cert, i) => (
            <ChainLink key={cert.sha256} cert={cert} index={i} at={report.checkedAt} />
          ))}
        </ol>
      </section>
    </div>
  );
}

export function TlsTool() {
  const { t } = useT();
  const gate = useScopeGate();
  const [target, setTarget] = useState("");
  const request = useRequest<TlsReport>("tls");
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
    void request.run((id) => builtinTools.tls(id, target.trim(), verdict.attestation));
  };

  const state = request.state;
  return (
    <div className="bt-tool bt-tls">
      <form className="bt-form" onSubmit={submit}>
        <Destination>
          <span className="mono">{target.trim() || "host:443"}</span> {t("builtin.tls.dest")}
        </Destination>
        <div className="bt-form__row">
          <Field label={t("builtin.tls.target")} className="bt-grow">
            {(id) => (
              <input
                id={id}
                className="input mono"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="example.com:443"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <RunButton
            running={state.phase === "running"}
            since={state.phase === "running" ? state.since : undefined}
            label={t("builtin.tls.run")}
            disabled={!available || !target.trim()}
            onCancel={request.cancel}
          />
        </div>
        <ScopeLine gate={gate} target={target} />
      </form>
      {!available && <DesktopOnly />}
      {blocked && <ErrorNote error={blocked} />}
      {state.phase === "error" && <ErrorNote error={state.error} />}
      {state.phase === "idle" && available && !blocked && <p className="bt-empty">{t("builtin.tls.empty")}</p>}
      {state.phase === "done" && (
        <>
          <TlsResult report={state.result} />
          <ResultActions
            tool="tls"
            target={`${state.result.host}:${state.result.port}`}
            text={tlsText(t, state.result)}
            data={state.result}
            title={`TLS · ${state.result.host}:${state.result.port}`}
            engagementId={gate.engagement?.id}
          />
        </>
      )}
    </div>
  );
}
