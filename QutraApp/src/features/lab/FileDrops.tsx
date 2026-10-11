import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { getDb } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { investigationFiles, type DroppedFiles } from "@/lib/investigationFiles";
import { useInvestigationFiles } from "@/state/investigationFiles";
import { useUi } from "@/state/ui";
import { toastAddOutcomes } from "./fileOutcomes";

/**
 * Files dropped on the window (spec 2026-10-07 §4.2). Rust keeps a
 * drop's paths and sends a token for them. While the Lab shows an
 * investigation (`dropTarget`) the files are added there; anywhere else the
 * toast says where to drop them. Mounted once, in the shell.
 */
export function FileDrops() {
  const { t } = useT();
  const navigate = useNavigate();
  const toast = useUi((s) => s.toast);
  // The listeners are added once; they read the latest of these.
  const latest = useRef({ t, navigate, toast });
  useEffect(() => {
    latest.current = { t, navigate, toast };
  });

  useEffect(() => {
    if (!investigationFiles.available()) return;
    let disposed = false;
    const stops: Array<() => void> = [];
    const keep = (stop: () => void) => {
      if (disposed) stop();
      else stops.push(stop);
    };

    const onDropped = async (drop: DroppedFiles) => {
      const { t, navigate, toast } = latest.current;
      const files = useInvestigationFiles.getState();
      const engagementId = files.dropTarget;
      if (!engagementId) {
        toast({ kind: "info", messageKey: "lab.files.dropElsewhere" });
        return;
      }
      try {
        const outcomes = await files.addDropped(drop.token, engagementId);
        const name = getDb().collection("engagements").get(engagementId)?.title;
        toastAddOutcomes(
          outcomes,
          toast,
          t,
          (file) => {
            const query = new URLSearchParams({
              e: engagementId,
              view: "targets",
              item: `file:${file.id}`,
            });
            navigate(`/lab?${query}`);
          },
          name,
        );
      } catch (error) {
        toast(
          error === "no_engagement_folder"
            ? { kind: "danger", messageKey: "lab.files.needFolderToast" }
            : { kind: "danger", messageKey: "lab.files.dropFailed" },
        );
      }
    };

    void investigationFiles
      .onDrag((over) => useInvestigationFiles.getState().setDragOver(over))
      .then(keep, () => {});
    void investigationFiles.onDropped((drop) => void onDropped(drop)).then(keep, () => {});
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, []);

  return null;
}
