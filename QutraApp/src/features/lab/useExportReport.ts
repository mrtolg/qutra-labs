import type { Engagement } from "@/domain/lab";
import { useT } from "@/lib/i18n";
import { useUi } from "@/state/ui";
import { exportEngagementReport } from "./exportReport";
import { reportWords, type ReportOptions } from "./reportBuild";

/** Export the engagement's report and say where it went: into its folder,
    with a way to open it, or to the browser's download. */
export function useExportReport(): (engagement: Engagement, options?: ReportOptions) => void {
  const { t } = useT();
  const toast = useUi((s) => s.toast);
  return (engagement, options) =>
    void exportEngagementReport(engagement, t("lab.report.fileWord"), reportWords(t), options).then(
      (saved) =>
        toast(
          saved.folder
            ? {
                kind: "success",
                messageKey: "lab.report.savedToFolder",
                params: { name: saved.fileName },
                actionKey: "lab.folder.open",
                onAction: () => void saved.openFolder(),
              }
            : { kind: "success", messageKey: "lab.report.exported" },
        ),
      () => toast({ kind: "danger", messageKey: "lab.report.exportFailed" }),
    );
}
