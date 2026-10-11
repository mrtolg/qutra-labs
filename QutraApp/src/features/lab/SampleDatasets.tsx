import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FilePlus2, FolderOpen } from "lucide-react";
import { useCollection } from "@/lib/db/database";
import { useT, type MessageKey } from "@/lib/i18n";
import { SAMPLE_IDS, sampleData, type SampleId } from "@/lib/sampleData";
import type { AddOutcome } from "@/lib/investigationFiles";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { formatBytes } from "./toolLabels";
import "./samples.css";

const SAMPLE_INFO: Record<SampleId, { title: MessageKey; detail: MessageKey; format: string }> = {
  "web-log": { title: "samples.webLog", detail: "samples.webLogDetail", format: "LOG" },
  pcap: { title: "samples.pcap", detail: "samples.pcapDetail", format: "PCAP" },
  program: { title: "samples.program", detail: "samples.programDetail", format: "EXE.sample" },
  photo: { title: "samples.photo", detail: "samples.photoDetail", format: "JPEG" },
  sarif: { title: "samples.sarif", detail: "samples.sarifDetail", format: "SARIF" },
  "event-log": { title: "samples.eventLog", detail: "samples.eventLogDetail", format: "CSV" },
};

export function SampleDatasets() {
  const { t, locale } = useT();
  const [params] = useSearchParams();
  const engagements = useCollection("engagements");
  const [chosenId, setChosenId] = useState(params.get("e") ?? "");
  const engagement = engagements.find((item) => item.id === chosenId && item.status !== "archived");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [result, setResult] = useState<{ engagementId: string; outcomes: AddOutcome[]; error?: MessageKey }>();
  const native = sampleData.available();
  const visibleResult = result?.engagementId === engagement?.id ? result : undefined;

  const generate = async (id: SampleId) => {
    if (!engagement || !native || busyRef.current) return;
    const engagementId = engagement.id;
    busyRef.current = true;
    setBusy(true);
    setResult(undefined);
    try {
      const outcomes = await sampleData.generate(engagementId, [id]);
      const files = outcomes.flatMap((outcome) => outcome.outcome === "failed" ? [] : [outcome.file]);
      useInvestigationFiles.setState((state) => ({
        byEngagement: {
          ...state.byEngagement,
          [engagementId]: [...new Map([
            ...(state.byEngagement[engagementId] ?? []), ...files,
          ].map((file) => [file.id, file])).values()],
        },
      }));
      setResult({ engagementId, outcomes });
    } catch (error) {
      setResult({ engagementId, outcomes: [], error: error === "no_engagement_folder" ? "samples.noFolder" : "samples.failed" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="samples">
      <div className="samples-destination">
        <label htmlFor="samples-investigation">{t("samples.investigation")}</label>
        <select className="select" id="samples-investigation" value={engagement?.id ?? ""} disabled={busy} onChange={(event) => {
          setChosenId(event.target.value);
          setResult(undefined);
        }}>
          <option value="">{t("samples.choose")}</option>
          {engagements.filter((item) => item.status !== "archived").map((item) => (
            <option key={item.id} value={item.id}>{item.title}</option>
          ))}
        </select>
        {engagement && <Link className="btn btn--sm" to={`/lab?e=${encodeURIComponent(engagement.id)}&view=targets`}>
          <FolderOpen size={14} aria-hidden /> {t("samples.openFiles")}
        </Link>}
      </div>
      <p className="samples-note">{t(native ? "samples.safety" : "samples.desktopOnly")}</p>
      <ul className="samples-list" aria-busy={busy}>
        {SAMPLE_IDS.map((id) => {
          const info = SAMPLE_INFO[id];
          return <li key={id}>
            <span className="samples-format">{info.format}</span>
            <div><h3>{t(info.title)}</h3><p>{t(info.detail)}</p></div>
            <button type="button" className="btn btn--sm" disabled={!native || !engagement || busy} onClick={() => void generate(id)}>
              <FilePlus2 size={14} aria-hidden /> {t(busy ? "samples.creating" : "samples.create")}
            </button>
          </li>;
        })}
      </ul>
      {visibleResult?.error && <p role="alert" className="callout callout--warning">{t(visibleResult.error)}</p>}
      {visibleResult && visibleResult.outcomes.length > 0 && <section aria-labelledby="samples-result-title" className="samples-results" aria-live="polite">
        <h3 id="samples-result-title">{t("samples.results")}</h3>
        <ul>{visibleResult.outcomes.map((outcome, index) => <li key={index}>
          <strong>{outcome.outcome === "failed" ? outcome.originalName : outcome.file.name}</strong>
          <span>{t(outcome.outcome === "added" ? "samples.added" : outcome.outcome === "duplicate" ? "samples.duplicate" : "samples.failed")}</span>
          {outcome.outcome !== "failed" && <>
            <span>{formatBytes(outcome.file.bytes, locale)}</span>
            <code>SHA-256 {outcome.file.sha256}</code>
          </>}
        </li>)}</ul>
      </section>}
    </div>
  );
}
