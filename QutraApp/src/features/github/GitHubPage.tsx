import { useEffect, useMemo, useRef, useState } from "react";
import {
  Github,
  Star,
  GitFork,
  Archive,
  Lock,
  Unlock,
  ExternalLink,
  AlertTriangle,
  WifiOff,
  Info,
  Search,
  RefreshCw,
  MapPin,
  Building2,
  Users,
  CircleDot,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { getBridge, isTauri } from "@/lib/bridge";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import {
  computeContributionStats,
  toWeeks,
  type GhProfile,
  type GhRepo,
  type GhContributionDay,
} from "@/domain/github";
import {
  GitHubProvider,
  GitHubApiError,
  githubClientId,
  type GhError,
} from "./provider";
import {
  runNativeDeviceFlow,
  type NativeDeviceFlowState,
} from "./nativeDeviceFlow";
import { demoProfile, demoRepos, demoContributions } from "./fixtures";
import { formatRelative } from "@/lib/time";
import { languageColor } from "./languageColors";
import "./github.css";

type View =
  | { kind: "loading" }
  | { kind: "disconnected" }
  | { kind: "connected"; demo: boolean; profile: GhProfile; repos: GhRepo[]; days: GhContributionDay[] }
  | { kind: "error"; code: GhError };

type RepoScope = "all" | "public" | "private" | "archived";

export default function GitHubPage() {
  const { t, locale } = useT();
  const provider = useMemo(() => new GitHubProvider(), []);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [pat, setPat] = useState("");
  const [patError, setPatError] = useState<string | null>(null);
  const [activityView, setActivityView] = useState<"chart" | "table">("chart");
  const [langFilter, setLangFilter] = useState<string>("all");
  const [repoScope, setRepoScope] = useState<RepoScope>("all");
  const [repoQuery, setRepoQuery] = useState("");
  const [deviceFlow, setDeviceFlow] =
    useState<NativeDeviceFlowState | null>(null);
  const deviceFlowAbort = useRef<{ aborted: boolean } | null>(null);
  const clientId = githubClientId();

  const loadLive = async () => {
    setView({ kind: "loading" });
    try {
      const [profile, repos] = await Promise.all([
        provider.getProfile(),
        provider.getRepos(),
      ]);
      let days: GhContributionDay[] = [];
      try {
        days = await provider.getContributions(profile.login);
      } catch {
        // Contributions are optional; profile/repos already loaded.
        days = [];
      }
      setView({ kind: "connected", demo: false, profile, repos, days });
    } catch (e) {
      const code = e instanceof GitHubApiError ? e.code : "github_error";
      if (code === "not_connected") setView({ kind: "disconnected" });
      else setView({ kind: "error", code });
    }
  };

  useEffect(() => {
    void (async () => {
      if (await provider.isConnected()) void loadLive();
      else setView({ kind: "disconnected" });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (deviceFlowAbort.current) deviceFlowAbort.current.aborted = true;
    },
    [],
  );

  const loadDemo = () =>
    setView({
      kind: "connected",
      demo: true,
      profile: demoProfile,
      repos: demoRepos,
      days: demoContributions(),
    });

  const connectPat = async () => {
    setPatError(null);
    const r = await provider.connectWithToken(pat);
    if (!r.ok) {
      setPatError(r.reason === "invalid_token_format" ? t("github.patInvalid") : t("github.connectFailed"));
      return;
    }
    setPat("");
    void loadLive();
  };

  const disconnect = async () => {
    await provider.disconnect();
    setView({ kind: "disconnected" });
  };

  const connectDeviceFlow = async () => {
    if (!clientId || !isTauri()) return;
    if (deviceFlowAbort.current) deviceFlowAbort.current.aborted = true;
    const signal = { aborted: false };
    deviceFlowAbort.current = signal;
    const terminal = await runNativeDeviceFlow(clientId, {
      signal,
      onState: (state) => {
        setDeviceFlow(state);
        if (state.phase === "awaiting") {
          void getBridge().openUrl(state.code.verificationUri);
        }
      },
    });
    if (terminal.phase === "authorized") {
      setDeviceFlow(null);
      await loadLive();
    }
  };

  const cancelDeviceFlow = () => {
    if (deviceFlowAbort.current) deviceFlowAbort.current.aborted = true;
    setDeviceFlow({ phase: "cancelled" });
  };

  const openUrl = (url: string) => void getBridge().openUrl(url);

  return (
    <div className="page github-page">
      <div className="page-header">
        <div className="page-title-row">
          <h1 className="flex" style={{ gap: 8, alignItems: "center" }}>
            <Github size={20} aria-hidden /> {t("nav.github")}
          </h1>
          <div style={{ flex: 1 }} />
          {view.kind === "connected" && (
            <div className="github-header-actions">
              {!view.demo && (
                <button
                  type="button"
                  className="btn btn--ghost btn--icon btn--sm"
                  aria-label={t("action.retry")}
                  title={t("action.retry")}
                  onClick={loadLive}
                >
                  <RefreshCw size={14} aria-hidden />
                </button>
              )}
              <button type="button" className="btn btn--secondary btn--sm" onClick={disconnect}>
                {t("github.disconnect")}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="page-body stack" style={{ gap: "var(--sp-4)" }}>
        {view.kind === "loading" && (
          <div className="skeleton" style={{ height: 120 }} aria-busy="true" />
        )}

        {view.kind === "error" &&
          (view.code === "unauthorized" || view.code === "forbidden" ? (
            // GitHub refused the saved token: Retry cannot fix that, a new
            // connection can.
            <EmptyState
              icon={AlertTriangle}
              title={
                view.code === "unauthorized"
                  ? t("github.stateUnauthorized")
                  : t("github.stateForbidden")
              }
              hint={
                view.code === "unauthorized"
                  ? t("github.stateUnauthorizedHint")
                  : t("github.stateForbiddenHint")
              }
              action={
                <button type="button" className="btn btn--primary" onClick={() => void disconnect()}>
                  {t("github.reconnect")}
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={view.code === "offline" ? WifiOff : AlertTriangle}
              title={
                view.code === "rate_limited"
                  ? t("github.stateRateLimited")
                  : view.code === "offline"
                    ? t("github.stateOffline")
                    : t("github.stateError")
              }
              hint={t("github.stateHint")}
              action={
                <button type="button" className="btn btn--secondary" onClick={loadLive}>
                  {t("action.retry")}
                </button>
              }
            />
          ))}

        {view.kind === "disconnected" && (
          <section className="panel">
            <div className="panel-body stack" style={{ gap: "var(--sp-4)" }}>
              <div className="flex" style={{ gap: 10 }}>
                <Github size={28} aria-hidden />
                <div>
                  <h2 style={{ margin: 0, fontSize: "var(--fs-16)" }}>{t("github.connectTitle")}</h2>
                  <p className="muted" style={{ fontSize: "var(--fs-13)", marginTop: 2 }}>
                    {t("github.connectSubtitle")}
                  </p>
                </div>
              </div>

              {/* Device Flow is not shipped in this build — PAT is the honest path. */}
              {clientId && isTauri() ? (
                <div className="stack" style={{ gap: 8 }}>
                  {deviceFlow?.phase === "awaiting" ? (
                    <div
                      className="callout callout--info stack"
                      style={{ gap: 8 }}
                      role="status"
                    >
                      <strong
                        className="mono"
                        style={{ fontSize: "var(--fs-18)" }}
                      >
                        {deviceFlow.code.userCode}
                      </strong>
                      <div className="flex" style={{ gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={() =>
                            void getBridge().openUrl(
                              deviceFlow.code.verificationUri,
                            )
                          }
                        >
                          <ExternalLink size={13} aria-hidden />
                          github.com/login/device
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={cancelDeviceFlow}
                        >
                          {t("action.cancel")}
                        </button>
                      </div>
                      <span className="faint">{t("common.loading")}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={deviceFlow?.phase === "requesting"}
                      aria-busy={deviceFlow?.phase === "requesting"}
                      onClick={() => void connectDeviceFlow()}
                    >
                      <Github size={15} aria-hidden />
                      {t("github.connectDeviceFlow")}
                    </button>
                  )}
                  {deviceFlow &&
                    ["denied", "expired", "error"].includes(
                      deviceFlow.phase,
                    ) && (
                      <p className="form-error" role="alert">
                        {t("github.connectFailed")}
                      </p>
                    )}
                </div>
              ) : (
                <p
                  className="callout callout--info"
                  style={{ fontSize: "var(--fs-13)" }}
                >
                  <Info size={14} aria-hidden />{" "}
                  {clientId
                    ? t("github.deviceFlowUnavailable")
                    : t("github.notConfigured")}
                </p>
              )}

              {/* Fine-grained PAT (desktop traffic goes through the Rust broker). */}
              <div className="stack" style={{ gap: 6 }}>
                <label className="setting-label" htmlFor="gh-pat">{t("github.connectPat")}</label>
                <p className="faint" style={{ fontSize: "var(--fs-12)" }}>{t("github.patHint")}</p>
                <div className="flex" style={{ gap: 8 }}>
                  <input
                    id="gh-pat"
                    type="password"
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="github_pat_…"
                    value={pat}
                    onChange={(e) => setPat(e.target.value)}
                  />
                  <button type="button" className="btn btn--secondary" disabled={!pat.trim()} onClick={connectPat}>
                    {t("github.connect")}
                  </button>
                </div>
                {patError && <p className="form-error" role="alert">{patError}</p>}
              </div>

              <div className="flex" style={{ gap: 8, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <span className="faint" style={{ flex: 1, fontSize: "var(--fs-12)" }}>{t("github.demoHint")}</span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={loadDemo}>
                  {t("github.previewDemo")}
                </button>
              </div>
            </div>
          </section>
        )}

        {view.kind === "connected" && (
          <ConnectedView
            view={view}
            activityView={activityView}
            setActivityView={setActivityView}
            langFilter={langFilter}
            setLangFilter={setLangFilter}
            repoScope={repoScope}
            setRepoScope={setRepoScope}
            repoQuery={repoQuery}
            setRepoQuery={setRepoQuery}
            openUrl={openUrl}
            onExitDemo={() => setView({ kind: "disconnected" })}
            t={t}
            locale={locale}
          />
        )}
      </div>
    </div>
  );
}

function ConnectedView({
  view,
  activityView,
  setActivityView,
  langFilter,
  setLangFilter,
  repoScope,
  setRepoScope,
  repoQuery,
  setRepoQuery,
  openUrl,
  onExitDemo,
  t,
  locale,
}: {
  view: Extract<View, { kind: "connected" }>;
  activityView: "chart" | "table";
  setActivityView: (v: "chart" | "table") => void;
  langFilter: string;
  setLangFilter: (v: string) => void;
  repoScope: RepoScope;
  setRepoScope: (v: RepoScope) => void;
  repoQuery: string;
  setRepoQuery: (v: string) => void;
  openUrl: (url: string) => void;
  onExitDemo: () => void;
  t: ReturnType<typeof useT>["t"];
  locale: string;
}) {
  const { profile, repos, days, demo } = view;
  const stats = useMemo(() => computeContributionStats(days), [days]);
  const weeks = useMemo(() => toWeeks(days), [days]);
  const languages = useMemo(
    () => ["all", ...Array.from(new Set(repos.map((r) => r.language).filter(Boolean) as string[]))],
    [repos],
  );
  const shown = useMemo(() => {
    const query = repoQuery.trim().toLocaleLowerCase(locale);
    return repos.filter((repo) => {
      const languageMatches = langFilter === "all" || repo.language === langFilter;
      const scopeMatches =
        repoScope === "all"
        || (repoScope === "public" && !repo.private && !repo.archived)
        || (repoScope === "private" && repo.private)
        || (repoScope === "archived" && repo.archived);
      const queryMatches =
        !query
        || repo.name.toLocaleLowerCase(locale).includes(query)
        || repo.description?.toLocaleLowerCase(locale).includes(query)
        || repo.language?.toLocaleLowerCase(locale).includes(query);
      return languageMatches && scopeMatches && queryMatches;
    });
  }, [langFilter, locale, repoQuery, repoScope, repos]);
  const repoTotals = useMemo(
    () => repos.reduce(
      (total, repo) => ({
        stars: total.stars + repo.stars,
        forks: total.forks + repo.forks,
        issues: total.issues + repo.openIssues,
      }),
      { stars: 0, forks: 0, issues: 0 },
    ),
    [repos],
  );

  return (
    <>
      {demo && (
        <div className="callout callout--warning" role="status" style={{ fontSize: "var(--fs-13)" }}>
          <Info size={14} aria-hidden /> {t("github.demoBanner")}{" "}
          <button type="button" className="btn btn--ghost btn--sm" onClick={onExitDemo}>
            {t("action.close")}
          </button>
        </div>
      )}

      <section className="github-profile" aria-labelledby="github-profile-name">
        <div className="github-profile-main">
          {profile.avatarUrl ? (
            <img
              className="gh-avatar gh-avatar--image"
              src={profile.avatarUrl}
              alt={profile.name ?? profile.login}
            />
          ) : (
            <div className="gh-avatar" aria-hidden>{profile.login.slice(0, 2).toUpperCase()}</div>
          )}
          <div className="github-profile-copy">
            <div className="github-profile-identity">
              <strong id="github-profile-name">{profile.name ?? profile.login}</strong>
              <span className="muted">@{profile.login}</span>
            </div>
            {profile.bio && <p>{profile.bio}</p>}
            <div className="github-profile-meta">
              {profile.company && <span><Building2 size={13} aria-hidden />{profile.company}</span>}
              {profile.location && <span><MapPin size={13} aria-hidden />{profile.location}</span>}
            </div>
          </div>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => openUrl(profile.htmlUrl)}>
            <ExternalLink size={13} aria-hidden /> {t("github.openProfile")}
          </button>
        </div>

        <div className="github-profile-stats" aria-label={t("nav.github")}>
          <div>
            <Users size={15} aria-hidden />
            <span>{t("github.followers")}</span>
            <strong>{profile.followers.toLocaleString(locale)}</strong>
          </div>
          <div>
            <Users size={15} aria-hidden />
            <span>{t("github.following")}</span>
            <strong>{profile.following.toLocaleString(locale)}</strong>
          </div>
          <div>
            <Github size={15} aria-hidden />
            <span>{t("github.repos")}</span>
            <strong>{profile.publicRepos.toLocaleString(locale)}</strong>
          </div>
          <div>
            <Star size={15} aria-hidden />
            <span>{t("github.total")}</span>
            <strong>{repoTotals.stars.toLocaleString(locale)}</strong>
          </div>
        </div>
      </section>

      {/* Contributions */}
      {days.length > 0 && (
        <section className="panel github-contributions">
          <div className="panel-header">
            <span className="panel-title">{t("github.contributions")}</span>
            <Segmented
              ariaLabel={t("github.contributions")}
              value={activityView}
              onChange={setActivityView}
              options={[
                { value: "chart", label: t("today.activityChart") },
                { value: "table", label: t("today.activityTable") },
              ]}
            />
          </div>
          <div className="panel-body">
            <div className="overview-stat-row" style={{ marginBottom: 12 }}>
              <div className="overview-stat"><strong>{stats.total}</strong><span>{t("github.total")}</span></div>
              <div className="overview-stat"><strong>{stats.activeDays}</strong><span>{t("github.activeDays")}</span></div>
              <div className="overview-stat"><strong>{stats.currentStreak}</strong><span>{t("github.currentStreak")}</span></div>
              <div className="overview-stat"><strong>{stats.longestStreak}</strong><span>{t("github.longestStreak")}</span></div>
            </div>
            {activityView === "chart" ? (
              <>
                <div className="gh-heatmap" role="img" aria-label={t("github.contributions")}>
                  {weeks.map((week, wi) => (
                    <div key={wi} className="gh-heatmap-col">
                      {week.map((d) => (
                        <span
                          key={d.date}
                          className="gh-cell"
                          data-level={d.level}
                          title={`${d.date}: ${d.count}`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                <p className="faint" style={{ fontSize: "var(--fs-12)", marginTop: 6 }}>{t("github.contributionsNote")}</p>
              </>
            ) : (
              <table className="table" style={{ border: 0 }}>
                <caption className="sr-only">{t("github.contributions")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("common.today")}</th>
                    <th scope="col">{t("github.total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {days.filter((d) => d.count > 0).slice(-14).reverse().map((d) => (
                    <tr key={d.date}><td>{d.date}</td><td>{d.count}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {/* Repositories */}
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">
            {t("github.repositories")}
            <span className="github-count">{shown.length}</span>
          </span>
          <div className="github-repo-totals" aria-label={t("github.repositories")}>
            <span title={t("github.stars")}><Star size={12} aria-hidden />{repoTotals.stars}</span>
            <span title={t("github.fork")}><GitFork size={12} aria-hidden />{repoTotals.forks}</span>
            <span title={t("lab.findings")}><CircleDot size={12} aria-hidden />{repoTotals.issues}</span>
          </div>
        </div>

        <div className="github-repo-toolbar">
          <Field label={t("github.searchRepositories")} className="github-repo-search-field">
            {(id) => (
              <div className="github-repo-search">
                <Search size={14} aria-hidden />
                <input
                  id={id}
                  value={repoQuery}
                  onChange={(event) => setRepoQuery(event.target.value)}
                  placeholder={`${t("github.repositories")}...`}
                />
              </div>
            )}
          </Field>
          <Segmented
            ariaLabel={t("github.repositories")}
            value={repoScope}
            onChange={setRepoScope}
            options={[
              { value: "all", label: t("common.all") },
              { value: "public", label: t("github.public") },
              { value: "private", label: t("github.private") },
              { value: "archived", label: t("github.archived") },
            ]}
          />
          {languages.length > 1 && (
              <Field label={t("github.filterLanguage")}>
                {(id) => (
                  <select
                    id={id}
                    className="input input--sm"
                    value={langFilter}
                    onChange={(e) => setLangFilter(e.target.value)}
                  >
                    {languages.map((l) => (
                      <option key={l} value={l}>{l === "all" ? t("github.filterAll") : l}</option>
                    ))}
                  </select>
                )}
              </Field>
            )}
        </div>

        <div className="row-list github-repo-list">
          {shown.map((r) => (
            <button key={r.id} type="button" className="row github-repo-row" onClick={() => openUrl(r.htmlUrl)}>
              <span className="github-repo-copy">
                <span className="github-repo-name">
                  <span className="truncate">{r.name}</span>
                  {r.private ? <Lock size={12} aria-label={t("github.private")} /> : <Unlock size={12} aria-label={t("github.public")} />}
                  {r.archived && <Archive size={12} aria-label={t("github.archived")} />}
                  {r.fork && <GitFork size={12} aria-label={t("github.fork")} />}
                </span>
                {r.description && (
                  <span className="muted truncate github-repo-description">{r.description}</span>
                )}
              </span>
              {r.language && (
                <span className="github-language">
                  <span className="github-language-dot" style={{ background: languageColor(r.language) }} />
                  {r.language}
                </span>
              )}
              <span className="github-repo-metric" title="Stars">
                <Star size={12} aria-hidden /> {r.stars}
              </span>
              <span className="github-repo-metric" title={t("github.fork")}>
                <GitFork size={12} aria-hidden /> {r.forks}
              </span>
              <span className="github-repo-metric" title={t("lab.findings")}>
                <CircleDot size={12} aria-hidden /> {r.openIssues}
              </span>
              <span className="github-repo-updated">
                {formatRelative(r.pushedAt, locale)}
              </span>
              <ExternalLink className="github-repo-open" size={13} aria-hidden />
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
