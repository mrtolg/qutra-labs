import { AlertTriangle, Copy, FolderOpen, Lock, ShieldAlert } from "lucide-react";
import { getBridge } from "@/lib/bridge";
import { useT } from "@/lib/i18n";
import type { InvestigationFile } from "@/lib/investigationFiles";
import { useUi } from "@/state/ui";
import { fileKindLabelKey } from "./fileKinds";
import { visibleName } from "./fileOutcomes";
import { formatBytes } from "./toolLabels";

/**
 * One file in an investigation (spec 2026-10-07 §5.3), inside its
 * LabDetail: what it is, where the copy is, and its hashes, each one
 * copyable. The copy is read-only, and one that could run has `.sample` at
 * the end of its name. A copy that has gone from the folder says so.
 */
export function FileCard({
  file,
  folderPath,
}: {
  file: InvestigationFile;
  /** The investigation's folder, when it is there to open. */
  folderPath: string | null;
}) {
  const { t, locale } = useT();
  const toast = useUi((s) => s.toast);
  const hashes = [
    ["SHA-256", file.sha256],
    ["SHA-1", file.sha1],
    ["MD5", file.md5],
  ] as const;

  const copy = async (name: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ kind: "success", messageKey: "lab.files.copied", params: { name } });
    } catch {
      toast({ kind: "danger", messageKey: "lab.files.copyFailed" });
    }
  };

  return (
    <div className="lab-fcard" data-testid="lab-file-card">
      {file.missing && (
        <p className="lab-fcard__note is-warn">
          <AlertTriangle size={13} aria-hidden /> {t("lab.files.missing")}
        </p>
      )}
      <dl className="lab-fcard__facts">
        <div>
          <dt>{t("lab.files.type")}</dt>
          <dd>{t(fileKindLabelKey(file.kind))}</dd>
        </div>
        <div>
          <dt>{t("lab.files.size")}</dt>
          <dd>
            <span>{formatBytes(file.bytes, locale)}</span>{" "}
            <span className="lab-fcard__exact">
              ({t("lab.files.bytes", { count: file.bytes.toLocaleString(locale) })})
            </span>
          </dd>
        </div>
        <div>
          <dt>{t("lab.files.addedAt")}</dt>
          <dd>
            {new Date(file.addedAt).toLocaleString(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })}{" "}
            · {t(`lab.files.source.${file.source}`)}
          </dd>
        </div>
        {file.originalName !== file.name && (
          <div>
            <dt>{t("lab.files.original")}</dt>
            <dd>{visibleName(file.originalName)}</dd>
          </div>
        )}
        <div>
          <dt>{t("lab.files.location")}</dt>
          <dd>
            <code>{file.relPath.replace(/\//g, "\\")}</code>
          </dd>
        </div>
      </dl>
      <h3 className="lab-fcard__sub">{t("lab.files.hashes")}</h3>
      <ul className="lab-fcard__hashes">
        {hashes.map(([name, value]) => (
          <li key={name} className="lab-fcard__hash">
            <span className="lab-fcard__algo">{name}</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-label={t("lab.files.copy", { name })}
              onClick={() => void copy(name, value)}
            >
              <Copy size={13} aria-hidden /> {t("lab.files.copyShort")}
            </button>
            <code className="lab-fcard__digest">{value}</code>
          </li>
        ))}
      </ul>
      {file.readOnly && (
        <p className="lab-fcard__note">
          <Lock size={13} aria-hidden /> {t("lab.files.readOnly")}
        </p>
      )}
      {file.sample && (
        <p className="lab-fcard__note is-warn">
          <ShieldAlert size={13} aria-hidden /> {t("lab.files.sample")}
        </p>
      )}
      {folderPath && (
        <button
          type="button"
          className="btn btn--secondary btn--sm lab-fcard__open"
          onClick={() => void getBridge().openPath(`${folderPath}\\files`)}
        >
          <FolderOpen size={13} aria-hidden /> {t("lab.files.openFolder")}
        </button>
      )}
    </div>
  );
}
