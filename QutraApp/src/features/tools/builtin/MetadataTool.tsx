import { FileSearch, MapPin, TriangleAlert } from "lucide-react";
import { useT } from "./i18n";
import type { BuiltinKey } from "./i18n";
import { builtinTools, type MetadataReport } from "@/lib/builtinTools";
import { HINTS, observationLabel, observationShown, own } from "@/features/lab/analysisLabels";
import { fileKindLabelKey } from "@/features/lab/fileKinds";
import { formatBytes } from "@/features/lab/toolLabels";
import { Destination, DesktopOnly, ErrorNote, Fact, ResultActions, shownDate, useRequest } from "./shared";
import { META_FLAGS, fieldLabel, metadataText, wordOr } from "./summaries";

/* Metadata inspector. Its result reads as an evidence label: the file's
   identity on the left (name, kind, size, SHA-256), and on the right what
   the file says about itself, the things worth a look first. */

const SOURCES = ["pdf", "office", "odf", "xmp"] as const;
const SENSITIVE = new Set(["image.gps", "image.owner", "image.serial"]);

function MetadataResult({ report }: { report: MetadataReport }) {
  const { t, locale } = useT();
  const interesting = report.observations.filter((o) => o.group === "interesting" && o.key !== "image.gps");
  const summary = report.observations.filter((o) => o.group === "summary" && o.key !== "identify.kind");
  const details = report.observations.filter((o) => o.group === "detail");
  const shown = (o: MetadataReport["observations"][number]) => observationShown(t, locale, o);

  return (
    <div className="bt-result bt-meta">
      <aside className="bt-label" aria-label={t("builtin.meta.identity")}>
        <p className="bt-eyebrow">{t(fileKindLabelKey(report.kind))}</p>
        <h3 className="bt-label__name">{report.name}</h3>
        <dl className="bt-facts">
          <Fact label={t("builtin.meta.size")} value={formatBytes(report.bytes, locale)} />
          <Fact label={t("builtin.meta.modified")} value={report.modifiedMs ? shownDate(report.modifiedMs, locale) : ""} />
          <Fact label="SHA-256" value={<span className="bt-hash">{report.sha256}</span>} mono />
        </dl>
        {report.limited && <p className="bt-note bt-note--quiet">{t("builtin.meta.limited")}</p>}
      </aside>

      <div className="bt-meta__body">
        {(report.flags.length > 0 || interesting.length > 0) && (
          <section className="bt-attention">
            <h4 className="bt-h4">
              <TriangleAlert size={14} aria-hidden /> {t("builtin.meta.attention")}
            </h4>
            <ul>
              {report.flags.map((flag) => (
                <li key={flag.key}>
                  <strong>{wordOr(t, "builtin.meta.flag", flag.key, META_FLAGS)}</strong>
                  <span className="bt-count">×{flag.count}</span>
                </li>
              ))}
              {interesting.map((o) => {
                const hint = o.hint ? own(HINTS, o.hint) : undefined;
                return (
                  <li key={o.id}>
                    <strong>{observationLabel(t, o)}</strong> <span className="mono">{shown(o)}</span>
                    {hint && <span className="bt-attention__why">{t(hint)}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {report.gps && (
          <section className="bt-gps">
            <h4 className="bt-h4">
              <MapPin size={14} aria-hidden /> {t("builtin.meta.gps")}
            </h4>
            <p className="bt-gps__coords mono">
              {report.gps.lat.toFixed(6)}, {report.gps.lon.toFixed(6)}
            </p>
            <p className="bt-gps__note">{t("builtin.meta.gpsNote")}</p>
          </section>
        )}

        {summary.length > 0 && (
          <section>
            <h4 className="bt-h4">{t("builtin.meta.summary")}</h4>
            <dl className="bt-facts bt-facts--grid">
              {summary.map((o) => (
                <Fact key={o.id} label={observationLabel(t, o)} value={shown(o)} />
              ))}
            </dl>
          </section>
        )}

        {SOURCES.map((source) => {
          const fields = report.fields.filter((f) => f.source === source);
          if (fields.length === 0) return null;
          return (
            <section key={source}>
              <h4 className="bt-h4">{t(`builtin.meta.source.${source}` as BuiltinKey)}</h4>
              <dl className="bt-facts bt-facts--grid">
                {fields.map((f, i) => (
                  <div key={`${f.key}-${i}`} className="bt-fact">
                    <dt>
                      {fieldLabel(t, f.key)}
                      {fieldLabel(t, f.key) !== f.key && <span className="bt-fact__key mono">{f.key}</span>}
                    </dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}

        {report.fields.length === 0 && report.tags.length === 0 && summary.length === 0 && !report.gps && (
          <p className="bt-empty">{t("builtin.meta.nothing")}</p>
        )}

        {(report.tags.length > 0 || details.length > 0) && (
          <details className="bt-details">
            <summary>{t("builtin.meta.raw", { count: report.tags.length + details.length })}</summary>
            <ul className="bt-tags mono">
              {details.map((o) => (
                <li key={o.id}>
                  {observationLabel(t, o)}: {shown(o)}
                  {o.items && o.items.length > 0 && ` — ${o.items.join(", ")}`}
                </li>
              ))}
              {report.tags.map((tag, i) => (
                <li key={`${tag}-${i}`}>{tag}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

export function MetadataTool() {
  const { t, locale } = useT();
  const request = useRequest<MetadataReport | null>("meta");
  const available = builtinTools.available();
  const state = request.state;
  const pick = () => void request.run(() => builtinTools.metadataPick(t("builtin.meta.dialogTitle")));
  const report = state.phase === "done" ? state.result : null;

  return (
    <div className="bt-tool bt-metadata">
      <Destination local />
      <div className="bt-form__row">
        <button type="button" className="btn btn--primary btn--sm" onClick={pick} disabled={!available || state.phase === "running"}>
          <FileSearch size={13} aria-hidden /> {report ? t("builtin.meta.pickAnother") : t("builtin.meta.pick")}
        </button>
        <span className="bt-form__hint">{t("builtin.meta.reads")}</span>
      </div>
      {!available && <DesktopOnly />}
      {state.phase === "running" && (
        <p className="bt-note bt-note--quiet" role="status">
          {t("builtin.meta.reading")}
        </p>
      )}
      {state.phase === "error" && <ErrorNote error={state.error} />}
      {(state.phase === "idle" || (state.phase === "done" && !report)) && available && (
        <p className="bt-empty">{t("builtin.meta.empty")}</p>
      )}
      {report && (
        <>
          <MetadataResult report={report} />
          <ResultActions
            tool="metadata"
            target={report.name}
            text={metadataText(t, report, (o) => `${observationLabel(t, o)}: ${observationShown(t, locale, o)}`)}
            data={report}
            title={`${t("tools.item.metadata.name")} · ${report.name}`}
            sensitive={Boolean(report.gps) || report.observations.some((o) => SENSITIVE.has(o.key))}
          />
        </>
      )}
    </div>
  );
}
