import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useT } from "@/lib/i18n";
import { getDb } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { diagnosticsText } from "./settingsDiagnostics";

export function ImportExportSection() {
  const { t } = useT();
  const toast = useUi((s) => s.toast);
  const db = getDb();
  const fileRef = useRef<HTMLInputElement>(null);
  /** The file picked, until the user confirms it replaces their data. */
  const [pending, setPending] = useState<File | null>(null);

  const exportAll = () => {
    const blob = new Blob([db.exportAll()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `contextos-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importFile = (file: File) => {
    void file.text().then(async (text) => {
      const result = await db.importAll(text);
      if (result.ok) {
        toast({
          kind: "success",
          messageKey: "settings.imported",
          params: { count: result.imported },
        });
      } else {
        toast({ kind: "danger", messageKey: "settings.importFailed" });
      }
    });
  };

  const exportDiagnostics = () => {
    const text = diagnosticsText();
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "contextos-diagnostics.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="settings-section">
      <div className="setting-row">
        <div>
          <div className="setting-label">{t("settings.exportAll")}</div>
          <div className="setting-hint">{t("settings.exportAllHint")}</div>
        </div>
        <button type="button" className="btn btn--secondary" onClick={exportAll}>
          <Download size={13} aria-hidden /> {t("action.export")}
        </button>
      </div>
      <div className="setting-row">
        <div className="setting-label">{t("settings.importData")}</div>
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="sr-only"
            aria-label={t("settings.importData")}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setPending(f);
              e.target.value = "";
            }}
          />
          <button type="button" className="btn btn--secondary" onClick={() => fileRef.current?.click()}>
            <Upload size={13} aria-hidden /> {t("action.import")}
          </button>
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-label">{t("settings.diagnostics")}</div>
        <button type="button" className="btn btn--secondary" onClick={exportDiagnostics}>
          {t("action.export")}
        </button>
      </div>
      <ConfirmDialog
        open={pending !== null}
        danger
        title={t("settings.importConfirm.title")}
        body={t("settings.importConfirm.body", { name: pending?.name ?? "" })}
        confirmLabel={t("settings.importConfirm.confirm")}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const file = pending;
          setPending(null);
          if (file) importFile(file);
        }}
      />
    </section>
  );
}
