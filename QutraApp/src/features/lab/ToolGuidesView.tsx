import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Activity,
  BookOpen,
  CheckCircle2,
  ClipboardPlus,
  ExternalLink,
  FileCheck2,
  Play,
  Search,
  ShieldAlert,
  BookOpenCheck,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import { getBridge } from "@/lib/bridge";
import { Field } from "@/components/ui/Field";
import { getDb, useCollection } from "@/lib/db/database";
import { composeLauncher } from "@/domain/tools/launcher";
import { createId } from "@/lib/id";
import { useT } from "@/lib/i18n";
import { now } from "@/lib/time";
import { useLabRuntime } from "@/state/labRuntime";
import { useUi } from "@/state/ui";
import { registeredToolsHref, toolsHref } from "@/domain/workbench";
import type { MessageKey } from "@/lib/i18n/en";
import { LabViewHeader } from "./LabViewHeader";
import { telemetryLabel } from "./telemetryTerms";
import {
  TOOL_CATALOG,
  TOOL_CATEGORY_LABELS,
  localizeText,
  type ToolCatalogEntry,
} from "./toolCatalog";
import {
  PRIVATE_LAB_PLAYBOOKS,
  getPrivateLabCopy,
  getToolUsageGuide,
  type PrivateLabTab,
} from "./toolGuidesData";

import { SampleDatasets } from "./SampleDatasets";

type InstallFilter = "all" | "installed" | "missing";

/** Each section says what it is for in its own line: the catalog, the
    playbooks and the datasets never share one description. */
const SECTION_PURPOSE = {
  catalog: "lab.purpose.guides",
  playbooks: "lab.purpose.playbooks",
  datasets: "lab.purpose.datasets",
} as const satisfies Record<PrivateLabTab, MessageKey>;

interface CatalogEntry {
  tool: ToolCatalogEntry;
  installation?: NativeToolInstallation;
}

const categoryTelemetry: Record<NativeToolInstallation["category"], string[]> = {
  local: ["stdout", "stderr", "artifacts"],
  network: ["flows", "packets", "service evidence"],
  web: ["requests", "responses", "alerts"],
  code: ["findings", "packages", "reports"],
  dfir: ["metadata", "timeline", "artifacts"],
};

function categoryFromNative(
  category: NativeToolInstallation["category"],
): ToolCatalogEntry["category"] {
  if (category === "local") return "dfir";
  return category;
}

function nativeCatalogTool(installation: NativeToolInstallation): ToolCatalogEntry {
  return {
    id: `native-${installation.id}`,
    name: installation.displayName,
    category: categoryFromNative(installation.category),
    repository: installation.docUrl || undefined,
    purpose: {
      en: "No guide yet. Run it from Tools.",
      tr: "Kılavuzu yok; Araçlar bölümünden çalıştırılır.",
    },
    telemetry: categoryTelemetry[installation.category],
  };
}

/**
 * A guide section of the Tools area (spec 2026-10-07 §5.1): the catalog, the
 * playbooks or the datasets. The sub-bar under the top bar picks the section
 * (`?view`), so there are no tabs inside.
 */
export function ToolGuidesView({ tab }: { tab: PrivateLabTab }) {
  const { t, locale } = useT();
  const copy = getPrivateLabCopy(locale);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // Every way out keeps the investigation the Tools area was opened for.
  const engagementId = params.get("e");
  const db = getDb();
  const { toast, announce } = useUi();
  const installations = useLabRuntime((state) => state.installations);
  const bindings = useCollection("installationBindings");
  const activeTab = tab;
  const setActiveTab = (next: PrivateLabTab) => navigate(toolsHref(next, engagementId));
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ToolCatalogEntry["category"] | "all">("all");
  const [installFilter, setInstallFilter] = useState<InstallFilter>("all");
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);

  const entries = useMemo<CatalogEntry[]>(() => {
    // A guide's installation is the one the user bound to it, never one
    // whose name looks right (data contracts §6).
    const launcher = composeLauncher(bindings, installations);
    const matched = new Set<string>();
    const catalog = TOOL_CATALOG.map((tool) => {
      const boundId = launcher.find((item) => item.guideId === tool.id)
        ?.installationIds[0];
      const installation = installations.find((candidate) => candidate.id === boundId);
      if (installation) matched.add(installation.id);
      return { tool, installation };
    });
    const nativeOnly = installations
      .filter((installation) => !matched.has(installation.id))
      .map((installation) => ({
        tool: nativeCatalogTool(installation),
        installation,
      }));
    return [...catalog, ...nativeOnly].sort((a, b) =>
      a.tool.name.localeCompare(b.tool.name),
    );
  }, [bindings, installations]);

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    return entries.filter(({ tool, installation }) => {
      const matchesQuery =
        !normalized ||
        [
          tool.name,
          localizeText(tool.purpose, locale),
          ...tool.telemetry.flatMap((term) => [term, telemetryLabel(term, locale)]),
          installation?.publisher ?? "",
        ].some((value) => value.toLocaleLowerCase(locale).includes(normalized));
      const matchesCategory = category === "all" || tool.category === category;
      const matchesInstall =
        installFilter === "all" ||
        (installFilter === "installed" && Boolean(installation)) ||
        (installFilter === "missing" && !installation);
      return matchesQuery && matchesCategory && matchesInstall;
    });
  }, [category, entries, installFilter, locale, query]);

  const selectedEntry =
    entries.find(({ tool }) => tool.id === selectedToolId) ?? null;

  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [selectedToolId]);

  const verifiedCount = entries.filter(
    ({ installation }) =>
      installation?.enabled && !installation.changedSinceVerify,
  ).length;
  const changedCount = entries.filter(
    ({ installation }) => installation?.changedSinceVerify,
  ).length;
  const installedCount = entries.filter(({ installation }) => installation).length;

  const openNativeTool = (installationId: string) => {
    navigate(registeredToolsHref(engagementId, installationId));
  };

  const createAcquisitionTask = (tool: ToolCatalogEntry) => {
    const timestamp = now();
    db.collection("tasks").put({
      id: createId("task"),
      title: `${copy.addTask}: ${tool.name}`,
      description: `${localizeText(tool.purpose, locale)}\n${tool.repository ?? ""}`,
      status: "backlog",
      priority: "medium",
      tags: ["private-lab", "tool-acquisition", tool.id],
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    toast({ kind: "success", message: copy.taskCreated });
    announce(copy.taskCreated);
  };

  const guide = selectedEntry ? getToolUsageGuide(selectedEntry.tool) : null;

  return (
    <section className="private-lab" aria-labelledby="private-lab-title">
      <header className="private-lab-head">
        <LabViewHeader
          id="private-lab-title"
          icon={BookOpenCheck}
          title={t(`tools.view.${activeTab}` as MessageKey)}
          purpose={t(SECTION_PURPOSE[activeTab])}
        />
        {/* Installed, verified and changed describe the tools on this
            computer, so they only mean something next to the catalog. */}
        {activeTab === "catalog" && (
          <dl className="private-lab-metrics">
            <div>
              <dt>{copy.installed}</dt>
              <dd>{installedCount}</dd>
            </div>
            <div>
              <dt>{copy.verified}</dt>
              <dd>{verifiedCount}</dd>
            </div>
            <div className={changedCount > 0 ? "is-warning" : undefined}>
              <dt>{copy.changed}</dt>
              <dd>{changedCount}</dd>
            </div>
            <div>
              <dt>{copy.availableTools}</dt>
              <dd>{entries.length}</dd>
            </div>
          </dl>
        )}
      </header>

      {activeTab === "catalog" && (
        <div id="private-lab-panel-catalog" className="private-lab-panel">
          <div className="private-lab-filters" style={{ alignItems: "flex-end" }}>
            <Field label={copy.search}>
              {(id) => (
                <div className="private-lab-search">
                  <Search size={15} aria-hidden />
                  <input
                    id={id}
                    className="input input--sm"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              )}
            </Field>
            <Field label={copy.category}>
              {(id) => (
                <select
                  id={id}
                  className="select select--sm"
                  value={category}
                  onChange={(event) =>
                    setCategory(event.target.value as ToolCatalogEntry["category"] | "all")
                  }
                >
                  <option value="all">{copy.allCategories}</option>
                  {Object.entries(TOOL_CATEGORY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{localizeText(label, locale)}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={copy.status}>
              {(id) => (
                <select
                  id={id}
                  className="select select--sm"
                  value={installFilter}
                  onChange={(event) =>
                    setInstallFilter(event.target.value as InstallFilter)
                  }
                >
                  <option value="all">{copy.allInstallations}</option>
                  <option value="installed">{copy.installedOnly}</option>
                  <option value="missing">{copy.missingOnly}</option>
                </select>
              )}
            </Field>
          </div>

          <div className="private-lab-workspace">
            <div className="lab-table-wrap private-lab-table">
              <table className="lab-table">
                <thead>
                  <tr>
                    <th>{copy.tool}</th>
                    <th>{copy.category}</th>
                    <th>{copy.purpose}</th>
                    <th>{copy.status}</th>
                    <th aria-label={copy.actions} />
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map(({ tool, installation }) => {
                    const selected = selectedEntry?.tool.id === tool.id;
                    return (
                      <tr
                        key={tool.id}
                        className={selected ? "is-selected" : undefined}
                        onClick={() => setSelectedToolId(tool.id)}
                      >
                        <td>
                          <strong>{tool.name}</strong>
                          <span className="private-lab-evidence">
                            {tool.telemetry
                              .slice(0, 2)
                              .map((term) => telemetryLabel(term, locale))
                              .join(" · ")}
                          </span>
                        </td>
                        <td>{localizeText(TOOL_CATEGORY_LABELS[tool.category], locale)}</td>
                        <td>{localizeText(tool.purpose, locale)}</td>
                        <td>
                          {installation ? (
                            <span
                              className={`private-lab-install${
                                installation.changedSinceVerify
                                  ? " is-changed"
                                  : " is-verified"
                              }`}
                            >
                              {installation.changedSinceVerify ? (
                                <ShieldAlert size={13} aria-hidden />
                              ) : (
                                <CheckCircle2 size={13} aria-hidden />
                              )}
                              {installation.changedSinceVerify
                                ? copy.identityChanged
                                : copy.verifiedNative}
                            </span>
                          ) : (
                            <span className="private-lab-install">
                              {copy.notRegistered}
                            </span>
                          )}
                        </td>
                        <td className="lab-table-actions">
                          <div className="private-lab-row-actions">
                            <button
                              type="button"
                              className="btn btn--icon btn--sm"
                              title={copy.openGuide}
                              aria-label={`${copy.openGuide}: ${tool.name}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedToolId(tool.id);
                              }}
                            >
                              <BookOpen size={14} aria-hidden />
                            </button>
                            {installation && (
                              <button
                                type="button"
                                className="btn btn--icon btn--sm"
                                title={copy.openNative}
                                aria-label={`${copy.openNative}: ${tool.name}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openNativeTool(installation.id);
                                }}
                              >
                                <Play size={14} aria-hidden />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredEntries.length === 0 && (
                <p className="private-lab-empty">{copy.noMatch}</p>
              )}
            </div>

            <aside
              ref={inspectorRef}
              className="private-lab-inspector"
              aria-label={copy.guide}
            >
              {selectedEntry && guide ? (
                <>
                  <div className="private-lab-inspector-head">
                    <div>
                      <span>{localizeText(TOOL_CATEGORY_LABELS[selectedEntry.tool.category], locale)}</span>
                      <h3>{selectedEntry.tool.name}</h3>
                    </div>
                  </div>
                  <p className="private-lab-inspector-purpose">
                    {localizeText(selectedEntry.tool.purpose, locale)}
                  </p>

                  <section>
                    <h4><TerminalSquare size={14} aria-hidden /> {copy.starterWorkflow}</h4>
                    <p>{localizeText(guide.goal, locale)}</p>
                    <div className="private-lab-command">
                      <span>{copy.commandPreview}</span>
                      {guide.command ? (
                        <code>{guide.command}</code>
                      ) : (
                        <p>{copy.commandUnavailable}</p>
                      )}
                    </div>
                  </section>

                  <section className="private-lab-guide-columns">
                    <div>
                      <h4>{copy.requiredInputs}</h4>
                      <ul>
                        {guide.inputs.map((item) => (
                          <li key={item.en}>{localizeText(item, locale)}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h4>{copy.expectedOutput}</h4>
                      <ul>
                        {guide.expected.map((item) => (
                          <li key={item.en}>{localizeText(item, locale)}</li>
                        ))}
                      </ul>
                    </div>
                  </section>

                  <section>
                    <h4>{copy.workflowSteps}</h4>
                    <ol>
                      {guide.steps.map((step) => (
                        <li key={step.en}>{localizeText(step, locale)}</li>
                      ))}
                    </ol>
                  </section>

                  <section className="private-lab-boundary">
                    <h4><ShieldCheck size={14} aria-hidden /> {copy.safetyBoundary}</h4>
                    <p>{localizeText(guide.boundary, locale)}</p>
                  </section>

                  <section>
                    <h4><Activity size={14} aria-hidden /> {copy.telemetry}</h4>
                    <div className="private-lab-tags">
                      {selectedEntry.tool.telemetry.map((item) => (
                        <span key={item}>{telemetryLabel(item, locale)}</span>
                      ))}
                    </div>
                  </section>

                  {selectedEntry.installation && (
                    <section className="private-lab-native">
                      <h4><FileCheck2 size={14} aria-hidden /> {copy.nativeIdentity}</h4>
                      <dl>
                        <div>
                          <dt>{copy.version}</dt>
                          <dd>{selectedEntry.installation.version || "—"}</dd>
                        </div>
                        <div>
                          <dt>{copy.publisher}</dt>
                          <dd>{selectedEntry.installation.publisher || "—"}</dd>
                        </div>
                        <div>
                          <dt>{copy.signature}</dt>
                          <dd>{selectedEntry.installation.signatureState}</dd>
                        </div>
                        <div>
                          <dt>{copy.path}</dt>
                          <dd className="mono" title={selectedEntry.installation.canonicalPath}>
                            {selectedEntry.installation.canonicalPath}
                          </dd>
                        </div>
                      </dl>
                    </section>
                  )}

                  <div className="private-lab-inspector-actions">
                    {selectedEntry.installation ? (
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => openNativeTool(selectedEntry.installation!.id)}
                      >
                        <Play size={14} aria-hidden /> {copy.openNative}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => createAcquisitionTask(selectedEntry.tool)}
                      >
                        <ClipboardPlus size={14} aria-hidden /> {copy.addTask}
                      </button>
                    )}
                    {selectedEntry.tool.repository && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() =>
                          void getBridge().openUrl(selectedEntry.tool.repository!)
                        }
                      >
                        <ExternalLink size={14} aria-hidden /> {copy.openSource}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="private-lab-inspector-empty">
                  <BookOpen size={22} aria-hidden />
                  <h3>{copy.selectTool}</h3>
                  <p>{copy.selectToolHint}</p>
                </div>
              )}
            </aside>
          </div>
        </div>
      )}

      {activeTab === "playbooks" && (
        <div id="private-lab-panel-playbooks" className="private-lab-panel private-lab-playbooks">
          {PRIVATE_LAB_PLAYBOOKS.map((playbook) => {
            const tools = playbook.toolIds
              .map((id) => entries.find((entry) => entry.tool.id === id))
              .filter((entry): entry is CatalogEntry => Boolean(entry));
            const firstInstalled = tools.find((entry) => entry.installation) ?? tools[0];
            return (
              <article key={playbook.id} className="private-lab-playbook">
                <div>
                  <h3>{localizeText(playbook.title, locale)}</h3>
                  <p>{localizeText(playbook.summary, locale)}</p>
                </div>
                <div>
                  <span className="private-lab-field-label">{copy.playbookTools}</span>
                  <ol className="private-lab-tool-chain">
                    {tools.map((entry) => (
                      <li key={entry.tool.id}>
                        {entry.installation && <CheckCircle2 size={13} aria-hidden />}
                        {entry.tool.name}
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <span className="private-lab-field-label">{copy.playbookOutput}</span>
                  <p>{localizeText(playbook.output, locale)}</p>
                </div>
                {firstInstalled && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setSelectedToolId(firstInstalled.tool.id);
                      setActiveTab("catalog");
                    }}
                  >
                    <BookOpen size={14} aria-hidden />
                    {copy.inspectFirstTool}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}

      {activeTab === "datasets" && <SampleDatasets key={engagementId ?? "none"} />}

    </section>
  );
}
