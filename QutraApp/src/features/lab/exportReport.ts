import { getBridge } from "@/lib/bridge";
import { getDb } from "@/lib/db/database";
import { engagementFolders, reportFileName } from "@/lib/engagementFolders";
import { now } from "@/lib/time";
import { createReportRecord, reportDownloadName } from "@/domain/lab/reportOps";
import type { Engagement } from "@/domain/lab";
import {
  DEFAULT_REPORT_OPTIONS,
  buildEngagementReport,
  type LabReportWords,
  type ReportOptions,
} from "./reportBuild";

export interface ExportedReport {
  /** True when the report was saved into the engagement's folder. */
  folder: boolean;
  fileName: string;
  openFolder: () => Promise<unknown>;
}

/**
 * Builds the engagement's Markdown report from its current findings and
 * evidence, the way the Rapor view previews it, and records it.
 * In the desktop app it is saved into the engagement's folder; without a
 * folder, and in the browser build, it goes to the browser's download.
 * `reportWord` names the file ("Rapor 2026-10-06 1530.md").
 */
export async function exportEngagementReport(
  engagement: Engagement,
  reportWord: string,
  words: LabReportWords,
  options: ReportOptions = DEFAULT_REPORT_OPTIONS,
): Promise<ExportedReport> {
  const db = getDb();
  const at = now();
  const evidence = db.collection("evidence").getAll();
  const built = buildEngagementReport({
    engagement,
    findings: db.collection("findings").getAll(),
    evidence,
    options,
    words,
    now: at,
  });
  const markdown = built.markdown;
  const record = await createReportRecord(
    {
      engagement,
      findings: built.included,
      evidence: evidence.filter((e) => e.engagementId === engagement.id),
      now: at,
      words,
    },
    markdown,
  );
  // The record is kept only once the file is out, so a failed write leaves
  // no "saved" report behind in the list or the summary.
  const keep = () => db.collection("reports").put(record);

  if (engagementFolders.available()) {
    const folder = await engagementFolders.get(engagement.id).catch(() => null);
    if (folder) {
      const fileName = reportFileName(reportWord, at);
      await engagementFolders.write(engagement.id, fileName, markdown);
      keep();
      return { folder: true, fileName, openFolder: () => getBridge().openPath(folder.path) };
    }
  }

  const fileName = reportDownloadName(engagement.title, at);
  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  keep();
  return { folder: false, fileName, openFolder: async () => undefined };
}
