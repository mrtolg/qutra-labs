import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Plus,
  Search,
  Shield,
} from "lucide-react";
import type { Engagement } from "@/domain/lab";
import { archivePatch, restorePatch } from "@/domain/lab/archive";
import type { EngagementScopeStatus } from "@/domain/lab/scope";
import { EmptyState } from "@/components/ui/EmptyState";
import { getDb, useCollection } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import { formatRelative, now } from "@/lib/time";
import { useUi } from "@/state/ui";
import { engagementStatusLabel } from "./labels";
import { kindIcon } from "./kindIcon";
import {
  openFindingsByEngagement,
  scopeStatusByEngagement,
  severityWeight,
} from "./investigationFacts";
import { SeverityPips } from "./SeverityPips";

/* Every investigation in one dense table: its
   state, scope, targets and open findings at a glance, sortable by each.
   The name is the row's link and its target covers the row (lab.css), so
   a click anywhere opens the investigation; archiving is one click with
   Undo. */

type SortKey = "name" | "status" | "scope" | "targets" | "findings" | "updated";
type Filter = "open" | "archived";

/** Work under way first, then what waits, then what is done. */
const STATUS_RANK: Record<Engagement["status"], number> = {
  active: 0,
  paused: 1,
  planned: 2,
  completed: 3,
  archived: 4,
};
/** What blocks work first. */
const SCOPE_RANK: Record<EngagementScopeStatus["status"], number> = {
  target_out_of_scope: 0,
  acknowledgement_required: 1,
  not_configured: 2,
  validated: 3,
};
const SCOPE_TONE: Record<EngagementScopeStatus["status"], string> = {
  target_out_of_scope: "is-blocked",
  acknowledgement_required: "is-warn",
  not_configured: "is-neutral",
  validated: "is-allowed",
};

/** Text and numbers read best the other way round at first click. */
const FIRST_DIR: Record<SortKey, "asc" | "desc"> = {
  name: "asc",
  status: "asc",
  scope: "asc",
  targets: "desc",
  findings: "desc",
  updated: "desc",
};

export function InvestigationList({ onCreate }: { onCreate: () => void }) {
  const { t, locale } = useT();
  const toast = useUi((s) => s.toast);
  const engagements = useCollection("engagements");
  const findings = useCollection("findings");
  const targets = useCollection("targets");
  const scopes = useCollection("authorizationScopes");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("open");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "updated",
    dir: "desc",
  });

  const openFindings = useMemo(() => openFindingsByEngagement(findings), [findings]);
  const scopeStatus = useMemo(
    () => scopeStatusByEngagement(engagements, scopes, targets),
    [engagements, scopes, targets],
  );
  const targetCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tg of targets) {
      // A target without an investigation counts for none.
      if (!tg.engagementId) continue;
      counts.set(tg.engagementId, (counts.get(tg.engagementId) ?? 0) + 1);
    }
    return counts;
  }, [targets]);

  const archivedCount = engagements.filter((e) => e.status === "archived").length;
  const openCount = engagements.length - archivedCount;
  const needle = query.trim().toLocaleLowerCase(locale);

  const rows = useMemo(() => {
    const value = (e: Engagement): number | string => {
      switch (sort.key) {
        case "name":
          return e.title.toLocaleLowerCase(locale);
        case "status":
          return STATUS_RANK[e.status];
        case "scope":
          return SCOPE_RANK[scopeStatus.get(e.id)?.status ?? "not_configured"];
        case "targets":
          return targetCount.get(e.id) ?? 0;
        case "findings":
          return severityWeight(openFindings.get(e.id));
        case "updated":
          return e.updatedAt;
      }
    };
    const sign = sort.dir === "asc" ? 1 : -1;
    return engagements
      .filter((e) => (filter === "archived" ? e.status === "archived" : e.status !== "archived"))
      .filter((e) => !needle || e.title.toLocaleLowerCase(locale).includes(needle))
      .sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        const by =
          typeof va === "string" && typeof vb === "string"
            ? va.localeCompare(vb, locale)
            : (va as number) - (vb as number);
        // Ties keep the newest work first.
        return by * sign || b.updatedAt - a.updatedAt;
      });
  }, [engagements, filter, needle, sort, locale, scopeStatus, targetCount, openFindings]);

  const sortBy = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_DIR[key] },
    );

  const setArchived = (e: Engagement, archived: boolean) => {
    const db = getDb();
    const before = {
      status: e.status,
      statusBeforeArchive: e.statusBeforeArchive,
      updatedAt: e.updatedAt,
    };
    db.collection("engagements").patch(e.id, archived ? archivePatch(e, now()) : restorePatch(e, now()));
    toast({
      kind: "success",
      messageKey: archived ? "lab.list.archived" : "lab.list.restored",
      params: { name: e.title },
      actionKey: "action.undo",
      // Undo puts back only what this click changed.
      onAction: () => db.collection("engagements").patch(e.id, before),
    });
  };

  if (engagements.length === 0) {
    return (
      <div className="lab-view-body">
        <EmptyState
          icon={Shield}
          title={t("lab.empty")}
          hint={t("lab.emptyHint")}
          action={
            <button type="button" className="btn btn--primary" data-guide="lab-new" onClick={onCreate}>
              <Plus size={15} aria-hidden /> {t("lab.newEngagement")}
            </button>
          }
        />
      </div>
    );
  }

  const column = (key: SortKey, labelKey: MessageKey, className?: string) => {
    const active = sort.key === key;
    const label = t(labelKey);
    const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th
        scope="col"
        className={className}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          className={active ? "lab-list__sort is-active" : "lab-list__sort"}
          title={t("lab.list.sort", { column: label })}
          onClick={() => sortBy(key)}
        >
          {label}
          <Icon size={13} aria-hidden />
        </button>
      </th>
    );
  };

  const emptyText = needle
    ? t("lab.switch.noMatch")
    : filter === "archived"
      ? t("lab.switch.noArchived")
      : t("lab.list.noOpen");

  return (
    <section className="lab-list" aria-labelledby="lab-list-title">
      <header className="lab-list__head">
        <div className="lab-list__titles">
          <h1 id="lab-list-title" className="lab-list__h1">
            {t("lab.list.title")}
          </h1>
          <p className="lab-list__sum">
            {t("lab.list.summary", { open: openCount, archived: archivedCount })}
          </p>
        </div>
        <div className="lab-list__tools">
          <label className="lab-list__search">
            <Search size={14} aria-hidden />
            <span className="sr-only">{t("lab.switch.search")}</span>
            <input
              type="search"
              value={query}
              placeholder={t("lab.switch.search")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="lab-list__seg" role="group" aria-label={t("lab.list.filter")}>
            {(["open", "archived"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {t(f === "open" ? "lab.list.filter.open" : "lab.list.filter.archived")}
                <span className="lab-list__n">{f === "open" ? openCount : archivedCount}</span>
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--primary" data-guide="lab-new" onClick={onCreate}>
            <Plus size={14} aria-hidden /> {t("lab.newEngagement")}
          </button>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="lab-list__empty" role="status">
          {emptyText}
        </p>
      ) : (
        <div className="lab-list__frame">
          <table className="lab-list__table">
            <caption className="sr-only">{t("lab.list.title")}</caption>
            <colgroup>
              <col className="lab-list__w-name" />
              <col className="lab-list__w-status" />
              <col className="lab-list__w-scope" />
              <col className="lab-list__w-num" />
              <col className="lab-list__w-findings" />
              <col className="lab-list__w-when" />
              <col className="lab-list__w-act" />
            </colgroup>
            <thead>
              <tr>
                {column("name", "lab.list.col.name", "lab-list__c-name")}
                {column("status", "lab.list.col.status")}
                {column("scope", "lab.list.col.scope")}
                {column("targets", "lab.list.col.targets", "lab-list__c-num")}
                {column("findings", "lab.list.col.findings")}
                {column("updated", "lab.list.col.updated")}
                <th scope="col" className="lab-list__c-act">
                  <span className="sr-only">{t("lab.list.col.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const Icon = kindIcon(e);
                const scope = scopeStatus.get(e.id);
                const scopeLabel =
                  scope?.status === "target_out_of_scope"
                    ? t("lab.scopeStatus.outOfScope", { count: scope.outOfScopeCount })
                    : t(`lab.scopeStatus.${scope?.status ?? "not_configured"}` as MessageKey);
                const archived = e.status === "archived";
                return (
                  <tr key={e.id} className={`lab-list__row is-${e.status}`}>
                    <td className="lab-list__c-name">
                      <div className="lab-list__ncell">
                        <span className="lab-list__kind" aria-hidden>
                          <Icon size={15} strokeWidth={1.7} />
                        </span>
                        <span className="lab-list__name">
                          <Link
                            to={`/lab?e=${encodeURIComponent(e.id)}&view=overview`}
                            className="lab-list__open"
                            title={e.title}
                          >
                            {e.title}
                          </Link>
                          <span className="lab-list__sub">
                            {t(`lab.kind.${e.kind ?? "general"}` as MessageKey)}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className={`lab-list__status is-${e.status}`}>
                        <span className="lab-list__dot" aria-hidden />
                        {engagementStatusLabel(t, e.status)}
                      </span>
                    </td>
                    <td>
                      <span className={`lab-scope-badge ${SCOPE_TONE[scope?.status ?? "not_configured"]}`}>
                        {scopeLabel}
                      </span>
                    </td>
                    <td className="lab-list__c-num">{targetCount.get(e.id) ?? 0}</td>
                    <td>
                      <SeverityPips counts={openFindings.get(e.id)} />
                    </td>
                    <td className="lab-list__when">
                      <time
                        dateTime={new Date(e.updatedAt).toISOString()}
                        title={new Date(e.updatedAt).toLocaleString(locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      >
                        {formatRelative(e.updatedAt, locale)}
                      </time>
                    </td>
                    <td className="lab-list__c-act">
                      <button
                        type="button"
                        className="btn btn--ghost btn--icon btn--sm"
                        aria-label={t(archived ? "lab.switch.restore" : "lab.switch.archive", {
                          name: e.title,
                        })}
                        title={t(archived ? "lab.switch.restoreShort" : "lab.switch.archiveShort")}
                        onClick={() => setArchived(e, !archived)}
                      >
                        {archived ? (
                          <ArchiveRestore size={14} aria-hidden />
                        ) : (
                          <Archive size={14} aria-hidden />
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
