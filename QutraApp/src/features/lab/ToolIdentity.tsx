import { Power, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import { useT } from "@/lib/i18n";
import { CatalogBindingSelect } from "./CatalogBindingSelect";
import { displayPath, formatBytes, signatureLabel } from "./toolLabels";

/**
 * What the app knows about the file it will start, and the actions that
 * change that record: check it again, trust a changed file, link it to its
 * guide, turn it off or remove it.
 */
export function ToolIdentity({
  installation,
  catalogId,
  onBind,
  busy,
  onReverify,
  onToggleEnabled,
  onRemove,
}: {
  installation: NativeToolInstallation;
  catalogId: string;
  onBind: (catalogId: string) => void;
  busy: string;
  onReverify: (acceptChangedIdentity: boolean) => void;
  onToggleEnabled: () => void;
  onRemove: () => void;
}) {
  const { t, locale } = useT();
  return (
    <div className="lab-tool-identity">
      {installation.changedSinceVerify && (
        <p className="lab-tool-identity__warn" role="note">
          {t("lab.tools.changedExplain")}
        </p>
      )}
      <dl className="lab-tool-facts">
        <div className="lab-tool-facts__wide">
          <dt>{t("lab.tools.path")}</dt>
          <dd className="mono">{displayPath(installation.canonicalPath)}</dd>
        </div>
        <div className="lab-tool-facts__wide">
          <dt>SHA-256</dt>
          <dd className="mono">{installation.sha256}</dd>
        </div>
        <div>
          <dt>{t("lab.tools.signature")}</dt>
          <dd>{signatureLabel(t, installation.signatureState)}</dd>
        </div>
        <div>
          <dt>{t("lab.tools.version")}</dt>
          <dd>{installation.version || "—"}</dd>
        </div>
        <div>
          <dt>{t("lab.tools.publisher")}</dt>
          <dd>{installation.publisher || "—"}</dd>
        </div>
        <div>
          <dt>{t("lab.tools.size")}</dt>
          <dd>{formatBytes(installation.sizeBytes, locale)}</dd>
        </div>
        <div>
          <dt>{t("lab.tools.lastVerified")}</dt>
          <dd>
            {new Date(installation.lastVerifiedAt).toLocaleString(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </dd>
        </div>
      </dl>

      <CatalogBindingSelect value={catalogId} onChange={onBind} />

      <div className="lab-tool-inline-actions">
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => onReverify(false)}
          disabled={busy === "verify"}
        >
          <RefreshCw size={13} aria-hidden /> {t("lab.tools.checkIdentity")}
        </button>
        {installation.changedSinceVerify && (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => onReverify(true)}
            disabled={busy === "verify"}
          >
            <ShieldCheck size={13} aria-hidden /> {t("lab.tools.trustNewIdentity")}
          </button>
        )}
        <span className="lab-grow" />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onToggleEnabled}
          disabled={busy === "toggle"}
        >
          <Power size={13} aria-hidden />{" "}
          {installation.enabled ? t("action.disable") : t("action.enable")}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onRemove}
          disabled={busy === "remove"}
        >
          <Trash2 size={13} aria-hidden /> {t("action.remove")}
        </button>
      </div>
    </div>
  );
}
