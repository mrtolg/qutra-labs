import { useState, type ReactNode } from "react";
import { FileSearch, ImageDown, ShieldCheck } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import type { Engagement, ToolProfile } from "@/domain/lab";
import { suggestCatalogIds } from "@/domain/tools/launcher";
import { getBridge } from "@/lib/bridge";
import type {
  NativeLocatedCandidate,
  NativeToolInstallation,
  RegisterNativeToolRequest,
} from "@/lib/bridge/types";
import { getDb, usePreferences } from "@/lib/db/database";
import { createId } from "@/lib/id";
import { now } from "@/lib/time";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { useLabRuntime } from "@/state/labRuntime";
import { bundledLogo } from "@/features/tools/logos/bundled";
import { useFetchedLogos } from "@/features/tools/logos/fetchedLogos";
import { CatalogBindingSelect } from "./CatalogBindingSelect";
import { setInstallationBinding } from "./installationBindings";
import { targetArg } from "./toolArgs";

/* Locate → review → register: one flow for every surface that offers it,
   the Lab's tool library and the tool launcher. The native picker hands back
   a candidate token; nothing is registered until the user confirms the
   review, and the catalog binding is the user's choice. A name can suggest
   it, never set it. */

export type RegisterDraft = Omit<RegisterNativeToolRequest, "candidateToken" | "confirmed">;

const DEFAULT_DRAFT: RegisterDraft = {
  displayName: "",
  category: "local",
  riskTier: "low",
  docUrl: "",
  tags: [],
};

const CATEGORIES: RegisterDraft["category"][] = ["local", "network", "web", "code", "dfir"];
const RISK_TIERS: RegisterDraft["riskTier"][] = ["info", "low", "medium", "high"];

/** Refusals that mean the reviewed pick can no longer be registered: the
    file changed on disk, the review outlived its token, or the token was
    already spent. Each is fixed the same way, by locating again. */
const LOCATE_AGAIN_REASONS = new Set([
  "candidate_changed",
  "candidate_token_expired",
  "candidate_token_invalid",
]);

export function profileFor(
  installation: NativeToolInstallation,
  engagement?: Engagement,
  /** The setting's name and its target field's name, in the user's language. */
  labels: { name?: string; target?: string } = {},
): ToolProfile {
  const timestamp = now();
  const requiresScope = installation.category === "network" || installation.category === "web";
  return {
    id: createId("profile"),
    installationId: installation.id,
    engagementId: engagement?.id,
    name: labels.name ?? installation.displayName,
    // A tool that must stay inside the scope starts with somewhere to name
    // its target; without one the launch gate refuses every run.
    args: requiresScope ? [targetArg(labels.target ?? "Target", 0)] : [],
    values: {},
    workingDir: installation.workingDir,
    allowedEnv: [],
    expectedOutputs: [],
    parser: "",
    timeoutSec: 300,
    concurrencyClass: "default",
    launchKind: "batch",
    requiresScope,
    favorite: false,
    demo: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** The launcher item the user asked to locate. It is preselected for the
    binding the review shows; the user still confirms it. */
export interface LocatePreset {
  catalogId: string;
  name: string;
  category: RegisterDraft["category"];
  /** The program's official page, kept as the registration's documentation
      address (and the place its logo may come from). */
  docUrl?: string;
}

/** The host a logo would come from, for the note that says so. */
function logoHost(docUrl: string): string {
  try {
    const url = new URL(docUrl.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname : "";
  } catch {
    return "";
  }
}

export function useLocateTool({
  engagement,
  onError,
  onRegistered,
}: {
  engagement?: Engagement;
  /** A message for the surface to show; "" clears it. */
  onError: (message: string) => void;
  onRegistered?: (installation: NativeToolInstallation, profile: ToolProfile) => void;
}): {
  locate: (preset?: LocatePreset) => Promise<void>;
  busy: "" | "pick" | "register";
  dialog: ReactNode;
} {
  const { t } = useT();
  const supervisor = getBridge().toolSupervisor;
  const refresh = useLabRuntime((state) => state.refresh);
  const logoFetch = usePreferences().toolLogoFetch;
  const fetchLogo = useFetchedLogos((state) => state.fetch);
  const [located, setLocated] = useState<NativeLocatedCandidate | null>(null);
  const [draft, setDraft] = useState<RegisterDraft>(DEFAULT_DRAFT);
  const [catalogId, setCatalogId] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"" | "pick" | "register">("");

  const locate = async (preset?: LocatePreset) => {
    setBusy("pick");
    onError("");
    try {
      const picked = await supervisor.locateCandidate(
        t("lab.tools.locateTitle"),
        t("lab.tools.locateFilter"),
      );
      if (!picked) return;
      const fileName = picked.candidate.fileName.replace(/\.exe$/i, "");
      // Preselected when the user asked for this item, or when the file name
      // points at exactly one; the review shows it either way.
      const suggestions = preset
        ? [preset.catalogId]
        : suggestCatalogIds({ displayName: fileName, docUrl: "", tags: [] });
      setLocated(picked);
      setDraft({
        ...DEFAULT_DRAFT,
        displayName: preset?.name ?? fileName,
        category: preset?.category ?? DEFAULT_DRAFT.category,
        docUrl: preset?.docUrl ?? DEFAULT_DRAFT.docUrl,
      });
      setCatalogId(suggestions.length === 1 ? suggestions[0]! : "");
      setOpen(true);
    } catch (caught) {
      onError(String(caught));
    } finally {
      setBusy("");
    }
  };

  const register = async () => {
    if (!located) return;
    setBusy("register");
    onError("");
    try {
      const saved = await supervisor.register({
        candidateToken: located.token,
        ...draft,
        confirmed: true,
      });
      const db = getDb();
      setInstallationBinding(db, saved.id, catalogId);
      const profile = profileFor(saved, engagement, {
        name: t("lab.tools.defaultProfileName", { name: saved.displayName }),
        target: t("lab.tools.run.targetArgName"),
      });
      db.collection("toolProfiles").put(profile);
      setOpen(false);
      setLocated(null);
      onRegistered?.(saved, profile);
      // A tool with no bundled logo gets its official one, once, from its
      // documentation address; the dialog said where before the click.
      if (logoFetch && !bundledLogo(catalogId) && saved.docUrl) void fetchLogo(saved.id);
      await refresh();
    } catch (caught) {
      const reason = String(caught);
      if (LOCATE_AGAIN_REASONS.has(reason)) {
        // The token is spent; keeping the dialog open would invite a retry
        // that can only fail the same way.
        setOpen(false);
        setLocated(null);
        onError(t("lab.tools.locateAgain"));
      } else {
        onError(reason);
      }
    } finally {
      setBusy("");
    }
  };

  const dialog = (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t("lab.tools.reviewTool")}
      wide
      preventClose={busy === "register"}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={() => setOpen(false)}>
            {t("action.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void register()}
            disabled={!draft.displayName.trim() || busy === "register"}
          >
            <ShieldCheck size={14} aria-hidden /> {t("lab.tools.confirmRegister")}
          </button>
        </>
      }
    >
      {located && (
        <div className="lab-add-tool">
          <div className="lab-add-identity">
            <FileSearch size={20} aria-hidden />
            <div>
              <strong>{located.candidate.fileName}</strong>
              <code>{located.candidate.canonicalPath}</code>
            </div>
          </div>
          <dl className="lab-tool-meta">
            <div>
              <dt>SHA-256</dt>
              <dd title={located.candidate.sha256}>{located.candidate.sha256}</dd>
            </div>
            <div>
              <dt>{t("lab.tools.signature")}</dt>
              <dd>{located.candidate.signatureState}</dd>
            </div>
            <div>
              <dt>{t("lab.tools.size")}</dt>
              <dd>{located.candidate.sizeBytes} B</dd>
            </div>
            <div>
              <dt>{t("lab.tools.workingDirectory")}</dt>
              <dd>
                <code>{located.workingDir}</code>
              </dd>
            </div>
          </dl>
          <div className="lab-add-grid">
            <label className="field">
              <span>{t("common.name")}</span>
              <input
                className="input"
                value={draft.displayName}
                onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
              />
            </label>
            <label className="field">
              <span>{t("lab.tools.category")}</span>
              <select
                className="select"
                value={draft.category}
                onChange={(event) =>
                  setDraft({ ...draft, category: event.target.value as RegisterDraft["category"] })
                }
              >
                {CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {t(`tools.category.${value}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("lab.tools.riskTier")}</span>
              <select
                className="select"
                value={draft.riskTier}
                onChange={(event) =>
                  setDraft({ ...draft, riskTier: event.target.value as RegisterDraft["riskTier"] })
                }
              >
                {RISK_TIERS.map((value) => (
                  <option key={value} value={value}>
                    {t(`lab.severity.${value}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("lab.tools.tags")}</span>
              <input
                className="input"
                value={draft.tags.join(", ")}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    tags: event.target.value
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <CatalogBindingSelect className="lab-add-wide" value={catalogId} onChange={setCatalogId} />
            <label className="field lab-add-wide">
              <span>{t("lab.tools.documentationUrl")}</span>
              <input
                className="input"
                type="url"
                value={draft.docUrl}
                onChange={(event) => setDraft({ ...draft, docUrl: event.target.value })}
                placeholder="https://"
              />
            </label>
          </div>
          <p className="lab-register-note">
            <ShieldCheck size={14} aria-hidden />
            {t("lab.tools.registerNote")}
          </p>
          {logoFetch && !bundledLogo(catalogId) && logoHost(draft.docUrl) && (
            <p className="lab-register-note" data-testid="register-logo-note">
              <ImageDown size={14} aria-hidden />
              {t("lab.tools.logoNote", { host: logoHost(draft.docUrl) })}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );

  return { locate, busy, dialog };
}
