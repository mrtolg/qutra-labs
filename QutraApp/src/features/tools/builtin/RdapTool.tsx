import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { useT } from "./i18n";
import type { BuiltinKey } from "./i18n";
import { Field } from "@/components/ui/Field";
import { builtinTools, type RdapReport } from "@/lib/builtinTools";
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
import { RDAP_EVENTS, RDAP_ROLES, eventSlug, rdapText, wordOr } from "./summaries";

/* IP / RDAP / ASN lookup. Its result reads as a registry record: who holds
   it, the block or name in large type, the record's life on one line from
   registration to expiry, then the contacts with their roles. */

function holder(report: RdapReport): string {
  const registrant = report.entities.find((e) => e.roles.includes("registrant") && e.name);
  const registrar = report.entities.find((e) => e.roles.includes("registrar") && e.name);
  return registrant?.name || (report.kind === "domain" ? registrar?.name : "") || report.name || report.handle;
}

function Timeline({ events }: { events: RdapReport["events"] }) {
  const { t, locale } = useT();
  const dated = events
    .map((e) => ({ ...e, ms: Date.parse(e.date) }))
    .filter((e) => !Number.isNaN(e.ms))
    .sort((a, b) => a.ms - b.ms);
  if (dated.length === 0) return null;
  return (
    <ol className="bt-timeline" aria-label={t("builtin.rdap.events")}>
      {dated.map((e, i) => (
        <li key={`${e.action}-${i}`} className={e.ms > Date.now() ? "is-future" : undefined}>
          <span className="bt-timeline__dot" aria-hidden />
          <span className="bt-timeline__what">{wordOr(t, "builtin.rdap.event", eventSlug(e.action), RDAP_EVENTS)}</span>
          <time className="bt-timeline__when" dateTime={e.date}>
            {shownDate(e.ms, locale)}
          </time>
        </li>
      ))}
    </ol>
  );
}

function RdapResult({ report }: { report: RdapReport }) {
  const { t } = useT();
  const block =
    report.kind === "ip" ? report.cidrs.join(", ") || report.range : report.kind === "autnum" ? report.asnRange : report.name;
  return (
    <div className="bt-result bt-record">
      <p className="bt-eyebrow">
        {t(`builtin.rdap.kind.${report.kind}` as BuiltinKey)}
        <span className="bt-servers">
          {report.servers.map((server, i) => (
            <span key={`${server}-${i}`} className="bt-chip mono">{server}</span>
          ))}
        </span>
      </p>
      <h3 className="bt-record__holder">{holder(report)}</h3>
      <p className="bt-record__block mono">{block}</p>

      <dl className="bt-facts bt-facts--grid">
        <Fact label={t("builtin.rdap.handle")} value={report.handle} mono />
        <Fact label={t("builtin.rdap.name")} value={report.kind !== "domain" ? report.name : ""} />
        <Fact label={t("builtin.rdap.range")} value={report.kind === "ip" ? report.range : ""} mono />
        <Fact label={t("builtin.rdap.type")} value={report.networkType} />
        <Fact label={t("builtin.rdap.country")} value={report.country} />
        <Fact label={t("builtin.rdap.parent")} value={report.parent} mono />
        <Fact label={t("builtin.rdap.status")} value={report.status.join(", ")} />
        <Fact label={t("builtin.rdap.nameservers")} value={report.nameservers.join(", ")} mono />
        <Fact
          label="DNSSEC"
          value={report.dnssec === null ? "" : report.dnssec ? t("builtin.rdap.dnssecOn") : t("builtin.rdap.dnssecOff")}
        />
        <Fact label={t("builtin.rdap.whois")} value={report.port43} mono />
      </dl>

      <Timeline events={report.events} />

      {report.entities.length > 0 && (
        <section>
          <h3 className="bt-h3">{t("builtin.rdap.contacts", { count: report.entities.length })}</h3>
          <ul className="bt-contacts">
            {report.entities.map((e) => (
              <li key={e.handle || e.name}>
                <span className="bt-contacts__roles">
                  {e.roles.map((role) => (
                    <span key={role} className={`bt-role${role === "abuse" ? " is-abuse" : ""}`}>
                      {wordOr(t, "builtin.rdap.role", role, RDAP_ROLES)}
                    </span>
                  ))}
                </span>
                <span className="bt-contacts__name">{e.name || e.handle}</span>
                {e.handle && e.name && <span className="bt-contacts__handle mono">{e.handle}</span>}
                {e.emails.map((mail) => (
                  <span key={mail} className="bt-contacts__mail mono">
                    <Mail size={12} aria-hidden /> {mail}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      {report.remarks.length > 0 && (
        <details className="bt-details">
          <summary>{t("builtin.rdap.remarks")}</summary>
          <p className="bt-remarks">{report.remarks.join(" ")}</p>
        </details>
      )}
    </div>
  );
}

export function RdapTool() {
  const { t } = useT();
  const gate = useScopeGate();
  const [target, setTarget] = useState("");
  const request = useRequest<RdapReport>("rdap");
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
    void request.run((id) => builtinTools.rdap(id, target.trim(), verdict.attestation));
  };

  const state = request.state;
  return (
    <div className="bt-tool bt-rdap">
      <form className="bt-form" onSubmit={submit}>
        <Destination>
          <span className="mono">{target.trim() || "…"}</span> {t("builtin.rdap.dest")}
        </Destination>
        <div className="bt-form__row">
          <Field label={t("builtin.rdap.target")} className="bt-grow">
            {(id) => (
              <input
                id={id}
                className="input mono"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="8.8.8.8 · example.com · AS15169"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <RunButton
            running={state.phase === "running"}
            since={state.phase === "running" ? state.since : undefined}
            label={t("builtin.rdap.run")}
            disabled={!available || !target.trim()}
            onCancel={request.cancel}
          />
        </div>
        <ScopeLine gate={gate} target={target} />
      </form>
      {!available && <DesktopOnly />}
      {blocked && <ErrorNote error={blocked} />}
      {state.phase === "error" && <ErrorNote error={state.error} />}
      {state.phase === "idle" && available && !blocked && <p className="bt-empty">{t("builtin.rdap.empty")}</p>}
      {state.phase === "done" && (
        <>
          <RdapResult report={state.result} />
          <ResultActions
            tool="rdap"
            target={state.result.query}
            text={rdapText(t, state.result)}
            data={state.result}
            title={`RDAP · ${state.result.query}`}
            engagementId={gate.engagement?.id}
          />
        </>
      )}
    </div>
  );
}
