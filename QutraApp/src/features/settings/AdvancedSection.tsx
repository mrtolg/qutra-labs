import { useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { getDb } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ToolLogoSetting } from "@/features/tools/ToolLogoSetting";

export function AdvancedSection() {
  const { t } = useT();
  const toast = useUi((s) => s.toast);
  const openSettings = useUi((s) => s.openSettings);
  const db = getDb();
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);

  return (
    <>
      <section className="settings-section">
        {/* Private Lab and the Jarvis switches live in Permissions, with
            their state, dates and what turning them off stops. */}
        <div className="setting-row">
          <div>
            <div className="setting-label">{t("settings.advanced.permissionsMoved")}</div>
            <div className="setting-hint">{t("settings.advanced.permissionsMovedHint")}</div>
          </div>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => openSettings("permissions")}
          >
            <KeyRound size={13} aria-hidden /> {t("settings.advanced.openPermissions")}
          </button>
        </div>
        <ToolLogoSetting />
        <div className="setting-row">
          <div>
            <div className="setting-label" style={{ color: "var(--danger)" }}>
              {t("settings.deleteAll")}
            </div>
          </div>
          <button
            type="button"
            className="btn btn--danger-outline"
            onClick={() => setDeleteAllOpen(true)}
          >
            <Trash2 size={13} aria-hidden /> {t("action.delete")}
          </button>
        </div>
      </section>

      <ConfirmDialog
        open={deleteAllOpen}
        title={t("settings.deleteAll")}
        body={t("settings.deleteAllBody")}
        confirmLabel={t("action.delete")}
        danger
        typeToConfirm="DELETE"
        onClose={() => setDeleteAllOpen(false)}
        onConfirm={async () => {
          await db.deleteEverything();
          setDeleteAllOpen(false);
          toast({ kind: "info", messageKey: "settings.deleteAllDone" });
          window.location.hash = "#/onboarding";
          window.location.reload();
        }}
      />
    </>
  );
}
