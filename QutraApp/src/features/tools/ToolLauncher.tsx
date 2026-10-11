import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  BookOpen,
  Copy,
  Download,
  ExternalLink,
  FileSearch,
  ImageDown,
  Link2,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { getBridge } from "@/lib/bridge";
import type { NativeToolInstallation } from "@/lib/bridge/types";
import { getDb, useCollection, usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { launchFailureMessage } from "@/lib/launch/launchFailureMessage";
import { formatRelative } from "@/lib/time";
import { useLabRuntime } from "@/state/labRuntime";
import { useUi } from "@/state/ui";
import { useTerminalTabs } from "@/features/terminal/terminalTabs";
import { TOOL_CATALOG as GUIDES, localizeText } from "@/features/lab/toolCatalog";
import { useLocateTool } from "@/features/lab/useLocateTool";
import { registeredToolsHref } from "@/domain/workbench";
import { setInstallationBinding } from "@/features/lab/installationBindings";
import {
  LAUNCHER_CATEGORIES,
  launcherTiles,
  registerCategoryFor,
  type LauncherCategory,
  type LauncherTile,
} from "@/domain/tools/launcherGrid";
import { useFetchedLogos } from "./logos/fetchedLogos";
import { ToolLogo } from "./logos/ToolLogo";
import { autolinkDetected } from "./autolink";
import { ToolGuideDialog } from "./ToolGuideDialog";
import "./launcher.css";

/* Araç kutusu (the toolbox). The programs Qutra Labs can
   open, densest first: what is ready to use, then what is one step away, each
   with that step. A tile's status is the user's binding plus Rust's
   installation record, and every launch goes through the native identity
   check: "Open in app" runs the program in a terminal tab at the app's
   current privilege, "Open" starts a GUI program in its own window.
   Running elevated stays a manual step the app does not track. */

type AdminTarget = { name: string; installation: NativeToolInstallation };

/** Where a tile stands, from the user's side: ready, one link away, needing
    a look, or not on this computer as far as Qutra Labs knows. */
export type Readiness = "ready" | "unlinked" | "attention" | "missing";
const READINESS: readonly Readiness[] = ["ready", "unlinked", "attention", "missing"];

function readinessOf(tile: LauncherTile): Readiness {
  switch (tile.status.kind) {
    case "ready":
      return "ready";
    case "changed":
    case "disabled":
    case "file_missing":
      return "attention";
    case "not_registered":
      return tile.candidates.length > 0 ? "unlinked" : "missing";
  }
}

/** A path the user can paste into a command prompt: Rust keeps the
    extended-length prefix on canonical paths. */
function displayPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function ToolLauncher({
  query,
  onQueryChange,
  actions,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  actions?: ReactNode;
}) {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const toast = useUi((s) => s.toast);
  const announce = useUi((s) => s.announce);
  const prefs = usePreferences();
  const runtime = useLabRuntime();
  const bindings = useCollection("installationBindings");
  const engagements = useCollection("engagements");
  const openToolTab = useTerminalTabs((s) => s.openToolTab);
  const fetchedLogos = useFetchedLogos((s) => s.byId);
  const loadLogos = useFetchedLogos((s) => s.load);
  const fetchLogo = useFetchedLogos((s) => s.fetch);
  const [category, setCategory] = useState<LauncherCategory | "all">("all");
  const [readiness, setReadiness] = useState<Readiness | "all">("all");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState("");
  const [admin, setAdmin] = useState<AdminTarget | null>(null);
  const [guide, setGuide] = useState<LauncherTile | null>(null);
  const [linkAllOpen, setLinkAllOpen] = useState(false);
  const [findingLogos, setFindingLogos] = useState(false);
  /* The stale registration a "Locate again" is replacing. Once the new file
     is registered and linked to the same program, the old one goes. */
  const replacing = useRef<{ installationId: string; catalogId: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const scanningNow = useRef(false);
  const scanned = useRef(false);
  const locator = useLocateTool({
    onError: setError,
    onRegistered: (saved) => {
      const old = replacing.current;
      replacing.current = null;
      if (!old) return;
      const link = getDb().collection("installationBindings").get(saved.id);
      if (link?.catalogId === old.catalogId) void dropRegistration(old.installationId);
    },
  });

  const native = runtime.available;
  // Until a good read, an empty installation list proves nothing.
  const known = !native || (runtime.ready && !runtime.readFailed);
  const { ensureSubscribed } = runtime;
  useEffect(() => {
    if (native && prefs.privateToolsEnabled) ensureSubscribed();
  }, [ensureSubscribed, native, prefs.privateToolsEnabled]);

  const installationIds = runtime.installations.map((i) => i.id).join("|");
  useEffect(() => {
    // Recorded logos only: reading them never touches the network.
    if (installationIds) void loadLogos(installationIds.split("|"));
  }, [installationIds, loadLogos]);

  /* "Run in an investigation" opens Registered tools for the investigation
     worked on last, the same one that screen picks with none named. */
  const latest = useMemo(
    () =>
      [...engagements]
        .filter((e) => e.status !== "archived")
        .sort((a, b) => b.updatedAt - a.updatedAt)[0],
    [engagements],
  );

  const tiles = useMemo(
    () => launcherTiles(bindings, runtime.installations),
    [bindings, runtime.installations],
  );
  const purpose = (tile: LauncherTile): string => {
    if (tile.registryId) return t(`tools.item.${tile.registryId}.summary` as MessageKey);
    const entry = GUIDES.find((g) => g.id === tile.guideId);
    return entry ? localizeText(entry.purpose, locale) : "";
  };
  const present = LAUNCHER_CATEGORIES.filter((c) => tiles.some((tile) => tile.category === c));
  const needle = query.trim().toLocaleLowerCase(locale);
  const matches = (tile: LauncherTile) =>
    (category === "all" || tile.category === category) &&
    (!needle ||
      tile.name.toLocaleLowerCase(locale).includes(needle) ||
      purpose(tile).toLocaleLowerCase(locale).includes(needle));
  const inView = tiles.filter(matches);
  const counts = Object.fromEntries(
    READINESS.map((r) => [r, inView.filter((tile) => readinessOf(tile) === r).length]),
  ) as Record<Readiness, number>;
  const shown = inView.filter((tile) => readiness === "all" || readinessOf(tile) === readiness);
  const ready = shown.filter((tile) => readinessOf(tile) === "ready");
  const waiting = shown
    .filter((tile) => readinessOf(tile) !== "ready")
    .sort((a, b) => READINESS.indexOf(readinessOf(a)) - READINESS.indexOf(readinessOf(b)));

  /* A registration whose name suggests exactly one tile, and no other tile,
     can be linked in one confirmed step. Anything ambiguous stays per tile. */
  const suggestions = useMemo(() => {
    const uses = new Map<string, number>();
    for (const tile of tiles) {
      for (const c of tile.candidates) uses.set(c.id, (uses.get(c.id) ?? 0) + 1);
    }
    return tiles
      .filter((tile) => tile.candidates.length === 1 && uses.get(tile.candidates[0]!.id) === 1)
      .map((tile) => ({ tile, installation: tile.candidates[0]! }));
  }, [tiles]);

  /* Registered programs no catalog item claims or suggests: the user's own.
     They open the same way, and their logo is the one fetched for them. */
  const others = useMemo(() => {
    const claimed = new Set(bindings.map((b) => b.installationId));
    const suggested = new Set(tiles.flatMap((tile) => tile.candidates.map((c) => c.id)));
    return runtime.installations
      .filter((i) => !claimed.has(i.id) && !suggested.has(i.id))
      .filter(
        (i) =>
          !needle ||
          i.displayName.toLocaleLowerCase(locale).includes(needle) ||
          i.tags.some((tag) => tag.toLocaleLowerCase(locale).includes(needle)),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName, locale));
  }, [bindings, tiles, runtime.installations, needle, locale]);
  const logoless = others.filter((i) => i.docUrl && !fetchedLogos[i.id]);
  const logoHosts = [...new Set(logoless.map((i) => hostOf(i.docUrl)).filter(Boolean))];

  const openInApp = (name: string, installation: NativeToolInstallation) => {
    // The renderer names the installation only; Rust resolves the path and
    // checks the file's identity when the terminal tab opens it.
    openToolTab({ installationId: installation.id, args: [], title: name });
    toast({ kind: "info", messageKey: "lab.tools.launchedInteractive", params: { name } });
    navigate("/terminal");
  };

  const openWindow = async (name: string, installation: NativeToolInstallation) => {
    setOpening(installation.id);
    setError("");
    try {
      const result = await getBridge().toolSupervisor.launchDetached(installation.id, []);
      if (result.ok) {
        toast({ kind: "success", messageKey: "lab.tools.launchedGui", params: { name } });
      } else {
        setError(launchFailureMessage(t, result.reason, name));
        // A refused launch can mean the file changed; show it as changed.
        void runtime.refresh();
      }
    } catch (caught) {
      setError(launchFailureMessage(t, String(caught), name));
    } finally {
      setOpening("");
    }
  };

  /* Take a registration whose file is gone out of the toolbox: the native
     record and the link to it. The program's file is not touched. */
  const dropRegistration = async (installationId: string) => {
    try {
      await getBridge().toolSupervisor.remove(installationId);
      setInstallationBinding(getDb(), installationId, "");
      await runtime.refresh();
    } catch (caught) {
      setError(String(caught));
    }
  };

  const removeStale = async (tile: LauncherTile, installation: NativeToolInstallation) => {
    await dropRegistration(installation.id);
    announce(t("launcher.linkRemoved", { name: tile.name }));
  };

  /* Look for the programs on this computer and link what is found. It runs
     once when the toolbox opens and again on request; a link that already
     works is never replaced. */
  const scan = async (manual: boolean) => {
    if (scanningNow.current) return;
    scanningNow.current = true;
    setScanning(true);
    if (manual) setError("");
    try {
      const summary = await autolinkDetected({
        supervisor: getBridge().toolSupervisor,
        db: getDb(),
        installations: useLabRuntime.getState().installations,
        labels: {
          profileName: (name) => t("lab.tools.defaultProfileName", { name }),
          targetArgName: t("lab.tools.run.targetArgName"),
        },
      });
      const count = summary.registered.length + summary.linked.length;
      if (count > 0) {
        await useLabRuntime.getState().refresh();
        toast({ kind: "success", messageKey: "launcher.autolinked", params: { count } });
      } else if (manual) {
        toast({ kind: "info", messageKey: "launcher.rescanNothing" });
      }
      if (manual && summary.failed > 0) {
        setError(t("launcher.autolinkFailed", { count: summary.failed }));
      }
    } catch (caught) {
      if (manual) setError(String(caught));
    } finally {
      scanningNow.current = false;
      setScanning(false);
    }
  };

  useEffect(() => {
    if (!native || !known || !prefs.privateToolsEnabled || scanned.current) return;
    scanned.current = true;
    void scan(false);
    // Once per visit, as soon as the registrations have been read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, known, prefs.privateToolsEnabled]);

  const locate = (tile: LauncherTile) => {
    replacing.current =
      tile.status.kind === "file_missing"
        ? { installationId: tile.status.installation.id, catalogId: tile.catalogId }
        : null;
    void locator.locate({
      catalogId: tile.catalogId,
      name: tile.name,
      category: registerCategoryFor(tile),
      docUrl: tile.downloadUrl,
    });
  };

  const link = (tile: LauncherTile, installation: NativeToolInstallation) => {
    setInstallationBinding(getDb(), installation.id, tile.catalogId);
    announce(t("launcher.linkedOne", { name: tile.name }));
  };

  const linkAll = () => {
    const db = getDb();
    for (const { tile, installation } of suggestions) {
      setInstallationBinding(db, installation.id, tile.catalogId);
    }
    setLinkAllOpen(false);
    toast({ kind: "success", messageKey: "launcher.linkedToast", params: { count: suggestions.length } });
  };

  const findLogos = async () => {
    setFindingLogos(true);
    let found = 0;
    for (const installation of logoless) {
      const view = await fetchLogo(installation.id);
      if (view?.state === "found") found += 1;
    }
    setFindingLogos(false);
    toast({
      kind: found > 0 ? "success" : "info",
      messageKey: "launcher.logosFound",
      params: { found, count: logoless.length },
    });
  };

  const runHref = (installation: NativeToolInstallation) =>
    registeredToolsHref(latest?.id, installation.id);
  const runHint = latest
    ? t("launcher.runInInvestigationHint", { title: latest.title })
    : t("launcher.runInInvestigationNone");

  /** The step that makes a row ready, when a sentence helps; a row that is
      simply not on this computer shows what the program is for instead. */
  const nextStep = (tile: LauncherTile): string => {
    switch (tile.status.kind) {
      case "changed":
        return t("launcher.next.changed");
      case "disabled":
        return t("launcher.next.disabled");
      case "file_missing":
        return t("launcher.next.fileMissing");
      case "not_registered":
        return tile.candidates.length > 0
          ? t("launcher.next.unlinked", { name: tile.candidates[0]!.displayName })
          : purpose(tile);
      case "ready":
        return "";
    }
  };

  const total = Math.max(1, READINESS.reduce((sum, r) => sum + counts[r], 0));

  return (
    <div className="tbx">
      <header className="tbx-head">
        <div className="tbx-head__title">
          <h1>{t("launcher.title")}</h1>
          <div className="tbx-head__meta">
            {native &&
              (known ? (
                <span className="tbx-meta-ok">
                  <ShieldCheck size={13} aria-hidden />
                  {t("launcher.registeredCount", { count: runtime.installations.length })}
                </span>
              ) : (
                !runtime.readFailed && <span>{t("launcher.reading")}</span>
              ))}
            {native && known && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={scanning}
                onClick={() => void scan(true)}
              >
                <RefreshCw size={13} aria-hidden />
                {t(scanning ? "launcher.rescanning" : "launcher.rescan")}
              </button>
            )}
            <Link to={registeredToolsHref()}>{t("launcher.libraryLink")}</Link>
            {actions}
          </div>
        </div>
        <Field label={t("launcher.filterLabel")} className="tbx-search">
          {(id) => (
            <input
              id={id}
              className="input"
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t("launcher.filterPlaceholder")}
            />
          )}
        </Field>
      </header>

      {/* The readiness strip: how much of the kit works right now. Each part
          of the legend filters the lists below it. Before the first good read
          the counts would be guesses, so it waits; the browser build
          registers nothing, so there it has nothing to say. */}
      {native && known && (
        <div className="tbx-meter">
          <div className="tbx-meter__bar" aria-hidden>
            {READINESS.map((r) =>
              counts[r] > 0 ? (
                <span key={r} className={`is-${r}`} style={{ flexGrow: counts[r] / total }} />
              ) : null,
            )}
          </div>
          <div className="tbx-meter__legend" role="group" aria-label={t("launcher.readinessLabel")}>
            {READINESS.map((r) => (
              <button
                key={r}
                type="button"
                className={`tbx-legend is-${r}`}
                aria-pressed={readiness === r}
                disabled={counts[r] === 0 && readiness !== r}
                onClick={() => setReadiness(readiness === r ? "all" : r)}
              >
                <span className="tbx-legend__dot" aria-hidden />
                {t(`launcher.readiness.${r}` as MessageKey)}
                <strong>{counts[r]}</strong>
              </button>
            ))}
            {native && known && suggestions.length > 0 && (
              <button
                type="button"
                className="btn btn--primary btn--sm tbx-meter__action"
                onClick={() => setLinkAllOpen(true)}
              >
                <Link2 size={13} aria-hidden />
                {t("launcher.linkAll", { count: suggestions.length })}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="tbx-chips" role="group" aria-label={t("launcher.categories")}>
        <button
          type="button"
          className="tbx-chip"
          aria-pressed={category === "all"}
          onClick={() => setCategory("all")}
        >
          {t("launcher.all", { count: tiles.length })}
        </button>
        {present.map((c) => (
          <button
            key={c}
            type="button"
            className="tbx-chip"
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
          >
            {t(`launcher.category.${c}` as MessageKey)}
          </button>
        ))}
      </div>

      {!native && (
        <p className="callout callout--info tbx-notice" data-testid="launcher-browser-notice">
          {t("launcher.browserNotice")}
        </p>
      )}
      {native && runtime.readFailed && (
        <div className="callout callout--warning tbx-notice" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>{t("launcher.readFailed")}</span>
          <button type="button" className="btn btn--sm" onClick={() => void runtime.refresh()}>
            {t("action.retry")}
          </button>
        </div>
      )}
      {error && (
        <div className="callout callout--warning tbx-notice" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>{error}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setError("")}>
            {t("action.close")}
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="muted tbx-empty">
          {needle ? t("launcher.noMatch", { query: query.trim() }) : t("launcher.noneInFilter")}
        </p>
      ) : (
        <>
          {native && (readiness === "all" || readiness === "ready") && (
            <section className="tbx-section" aria-labelledby="tbx-ready">
              <h2 id="tbx-ready" className="tbx-section__title">
                {t("launcher.section.ready")} <span>{ready.length}</span>
              </h2>
              {ready.length === 0 ? (
                <p className="tbx-section__empty">{t("launcher.readyEmpty")}</p>
              ) : (
                <ul className="tbx-ready" aria-labelledby="tbx-ready">
                  {ready.map((tile) => {
                    if (tile.status.kind !== "ready") return null;
                    const { installation } = tile.status;
                    const headingId = `tool-tile-${tile.catalogId}`;
                    return (
                      <li
                        key={tile.catalogId}
                        className="tbx-card"
                        aria-labelledby={headingId}
                        data-testid="tool-tile"
                      >
                        <ToolLogo
                          name={tile.name}
                          catalogId={tile.catalogId}
                          installationId={installation.id}
                          category={tile.category}
                          size={40}
                        />
                        <div className="tbx-card__body">
                          <h3 id={headingId} className="tbx-card__name">
                            {tile.name}
                          </h3>
                          <p className="tbx-card__purpose" title={purpose(tile)}>
                            {purpose(tile)}
                          </p>
                          <p className="tbx-card__facts">
                            <span className="tbx-status is-ready">{t("launcher.status.ready")}</span>
                            <span>{t(`launcher.category.${tile.category}` as MessageKey)}</span>
                            {installation.version && <span>{installation.version}</span>}
                            {installation.lastVerifiedAt > 0 && (
                              <span title={t("launcher.lastVerified", {
                                when: formatRelative(installation.lastVerifiedAt, locale),
                              })}>
                                {t("launcher.verifiedAgo", {
                                  when: formatRelative(installation.lastVerifiedAt, locale),
                                })}
                              </span>
                            )}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon btn--sm tbx-card__admin"
                          title={t("launcher.adminInstructions")}
                          aria-label={t("launcher.adminInstructions")}
                          aria-describedby={headingId}
                          onClick={() => setAdmin({ name: tile.name, installation })}
                        >
                          <ShieldAlert size={14} aria-hidden />
                        </button>
                        <div className="tbx-card__actions">
                          {tile.modes.includes("terminal") && (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              title={t("launcher.openInAppHint")}
                              aria-describedby={headingId}
                              onClick={() => openInApp(tile.name, installation)}
                            >
                              <TerminalSquare size={13} aria-hidden />
                              {t("launcher.openInApp")}
                            </button>
                          )}
                          {tile.modes.includes("external_gui") && (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              title={t("launcher.openWindowHint")}
                              aria-describedby={headingId}
                              disabled={opening === installation.id}
                              onClick={() => void openWindow(tile.name, installation)}
                            >
                              <ExternalLink size={13} aria-hidden />
                              {t("launcher.openWindow")}
                            </button>
                          )}
                          <Link
                            className="btn btn--secondary btn--sm"
                            to={runHref(installation)}
                            title={runHint}
                            aria-describedby={headingId}
                          >
                            <Play size={13} aria-hidden />
                            {t("launcher.runInInvestigation")}
                          </Link>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            aria-describedby={headingId}
                            onClick={() => setGuide(tile)}
                          >
                            <BookOpen size={13} aria-hidden />
                            {t("launcher.guide")}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {waiting.length > 0 && (
            <section className="tbx-section" aria-labelledby="tbx-waiting">
              <h2 id="tbx-waiting" className="tbx-section__title">
                {t(native ? "launcher.section.waiting" : "launcher.section.programs")}{" "}
                <span>{waiting.length}</span>
              </h2>
              <ul className="tbx-waiting" aria-labelledby="tbx-waiting">
                {waiting.map((tile) => {
                  const state = readinessOf(tile);
                  const headingId = `tool-tile-${tile.catalogId}`;
                  const { status } = tile;
                  return (
                    <li
                      key={tile.catalogId}
                      className="tbx-row"
                      aria-labelledby={headingId}
                      data-testid="tool-tile"
                    >
                      <ToolLogo
                        name={tile.name}
                        catalogId={tile.catalogId}
                        category={tile.category}
                        size={30}
                      />
                      <div className="tbx-row__body">
                        <div className="tbx-row__line">
                          <h3 id={headingId} className="tbx-row__name">
                            {tile.name}
                          </h3>
                          {/* The browser build cannot know what is on this computer. */}
                          {native && (
                            <span className={`tbx-status is-${known ? state : "checking"}`}>
                              {!known
                                ? t("launcher.status.checking")
                                : status.kind === "file_missing"
                                  ? t("launcher.status.fileMissing")
                                  : t(`launcher.readiness.${state}` as MessageKey)}
                            </span>
                          )}
                        </div>
                        <p className="tbx-row__next" title={purpose(tile)}>
                          {known ? nextStep(tile) : purpose(tile)}
                        </p>
                      </div>
                      <div className="tbx-row__actions">
                        {status.kind === "not_registered" && native && known &&
                          tile.candidates.slice(0, 1).map((candidate) => (
                            // The name suggests it, the user's click confirms it.
                            <button
                              key={candidate.id}
                              type="button"
                              className="btn btn--primary btn--sm"
                              aria-label={t("launcher.link", { name: candidate.displayName })}
                              aria-describedby={headingId}
                              onClick={() => link(tile, candidate)}
                            >
                              <Link2 size={13} aria-hidden />
                              {t("launcher.linkShort")}
                            </button>
                          ))}
                        {status.kind === "not_registered" && native && known && tile.candidates.length === 0 && (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            aria-describedby={headingId}
                            disabled={locator.busy !== ""}
                            onClick={() => locate(tile)}
                          >
                            <FileSearch size={13} aria-hidden />
                            {t("launcher.locate")}
                          </button>
                        )}
                        {status.kind === "file_missing" && native && known && (
                          <>
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              aria-describedby={headingId}
                              disabled={locator.busy !== ""}
                              onClick={() => locate(tile)}
                            >
                              <FileSearch size={13} aria-hidden />
                              {t("launcher.relink")}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--icon btn--sm"
                              title={t("launcher.removeLink")}
                              aria-label={t("launcher.removeLink")}
                              aria-describedby={headingId}
                              onClick={() => void removeStale(tile, status.installation)}
                            >
                              <Trash2 size={14} aria-hidden />
                            </button>
                          </>
                        )}
                        {(status.kind === "changed" || status.kind === "disabled") && (
                          <Link
                            className="btn btn--secondary btn--sm"
                            aria-describedby={headingId}
                            to={registeredToolsHref(undefined, status.installation.id)}
                          >
                            {t("launcher.reviewInLab")}
                          </Link>
                        )}
                        {(status.kind === "not_registered" || status.kind === "file_missing") &&
                          tile.candidates.length === 0 && tile.downloadUrl && (
                          <button
                            type="button"
                            className="btn btn--ghost btn--icon btn--sm"
                            title={t("launcher.download")}
                            aria-label={t("launcher.download")}
                            aria-describedby={headingId}
                            onClick={() => void getBridge().openUrl(tile.downloadUrl)}
                          >
                            <Download size={14} aria-hidden />
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon btn--sm"
                          title={t("launcher.guide")}
                          aria-label={t("launcher.guide")}
                          aria-describedby={headingId}
                          onClick={() => setGuide(tile)}
                        >
                          <BookOpen size={14} aria-hidden />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}

      {native && known && others.length > 0 && readiness === "all" && category === "all" && (
        <details className="tbx-others">
          <summary>
            {t("launcher.section.others")} <span>{others.length}</span>
          </summary>
          {prefs.toolLogoFetch && logoless.length > 0 && (
            <p className="tbx-others__logos">
              <span>{t("launcher.findLogosHint", { hosts: logoHosts.join(", ") })}</span>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={findingLogos}
                onClick={() => void findLogos()}
              >
                <ImageDown size={13} aria-hidden />
                {t("launcher.findLogos", { count: logoless.length })}
              </button>
            </p>
          )}
          <ul className="tbx-waiting">
            {others.map((installation) => {
              const headingId = `tool-other-${installation.id}`;
              const ok =
                installation.enabled && !installation.changedSinceVerify && !installation.fileMissing;
              return (
                <li
                  key={installation.id}
                  className="tbx-row"
                  aria-labelledby={headingId}
                  data-testid="tool-other"
                >
                  <ToolLogo
                    name={installation.displayName}
                    installationId={installation.id}
                    size={30}
                  />
                  <div className="tbx-row__body">
                    <h3 id={headingId} className="tbx-row__name">
                      {installation.displayName}
                    </h3>
                    <p className="tbx-row__next">
                      {[installation.version, installation.publisher].filter(Boolean).join(" · ") ||
                        t(`tools.category.${installation.category}` as MessageKey)}
                    </p>
                  </div>
                  <div className="tbx-row__actions">
                    {ok ? (
                      <>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          title={t("launcher.openInAppHint")}
                          aria-describedby={headingId}
                          onClick={() => openInApp(installation.displayName, installation)}
                        >
                          <TerminalSquare size={13} aria-hidden />
                          {t("launcher.openInApp")}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon btn--sm"
                          title={t("launcher.openWindowHint")}
                          aria-label={t("launcher.openWindow")}
                          aria-describedby={headingId}
                          disabled={opening === installation.id}
                          onClick={() => void openWindow(installation.displayName, installation)}
                        >
                          <ExternalLink size={14} aria-hidden />
                        </button>
                        <Link
                          className="btn btn--ghost btn--icon btn--sm"
                          to={runHref(installation)}
                          title={runHint}
                          aria-label={t("launcher.runInInvestigation")}
                          aria-describedby={headingId}
                        >
                          <Play size={14} aria-hidden />
                        </Link>
                      </>
                    ) : (
                      <Link
                        className="btn btn--secondary btn--sm"
                        aria-describedby={headingId}
                        to={registeredToolsHref(undefined, installation.id)}
                      >
                        {t("launcher.reviewInLab")}
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      <p className="tbx-footnote">{t("launcher.footnote")}</p>

      {locator.dialog}
      <ToolGuideDialog tile={guide} purpose={guide ? purpose(guide) : ""} onClose={() => setGuide(null)} />
      <Dialog
        open={linkAllOpen}
        onClose={() => setLinkAllOpen(false)}
        title={t("launcher.linkAllTitle")}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setLinkAllOpen(false)}>
              {t("action.cancel")}
            </button>
            <button type="button" className="btn btn--primary" onClick={linkAll}>
              <Link2 size={14} aria-hidden />
              {t("launcher.linkAllConfirm", { count: suggestions.length })}
            </button>
          </>
        }
      >
        <p>{t("launcher.linkAllBody")}</p>
        <ul className="tbx-linklist">
          {suggestions.map(({ tile, installation }) => (
            <li key={tile.catalogId}>
              <ToolLogo name={tile.name} catalogId={tile.catalogId} category={tile.category} size={24} />
              <strong>{tile.name}</strong>
              <span className="tbx-linklist__arrow" aria-hidden>←</span>
              <span className="tbx-linklist__file" title={displayPath(installation.canonicalPath)}>
                {installation.displayName}
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
      <AdminInstructions target={admin} onClose={() => setAdmin(null)} />
    </div>
  );
}

/** Running elevated is the user's own step, outside the
    app. The app shows which file it registered and says it does not track
    a run started this way. */
function AdminInstructions({
  target,
  onClose,
}: {
  target: AdminTarget | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const toast = useUi((s) => s.toast);
  const command = target ? `"${displayPath(target.installation.canonicalPath)}"` : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast({ kind: "success", messageKey: "toast.copied" });
    } catch {
      toast({ kind: "danger", messageKey: "launcher.copyFailed" });
    }
  };
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={target ? t("launcher.adminTitle", { tool: target.name }) : ""}
      footer={
        <button type="button" className="btn btn--secondary" onClick={onClose}>
          {t("action.close")}
        </button>
      }
    >
      {target && (
        <div className="launcher-admin">
          <p>{t("launcher.adminIntro")}</p>
          <ol>
            <li>{t("launcher.adminStep1")}</li>
            <li>
              {t("launcher.adminStep2")}
              <div className="launcher-command">
                <code>{command}</code>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => void copy()}>
                  <Copy size={13} aria-hidden />
                  {t("action.copy")}
                </button>
              </div>
            </li>
          </ol>
          <p className="muted">{t("launcher.adminUntracked")}</p>
        </div>
      )}
    </Dialog>
  );
}
