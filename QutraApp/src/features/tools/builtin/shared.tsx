import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, Copy, Download, FilePlus2, Lock, Square, TriangleAlert } from "lucide-react";
import { useT } from "./i18n";
import type { BuiltinKey } from "./i18n";
import { getDb, useCollection } from "@/lib/db/database";
import { useUi } from "@/state/ui";
import { now } from "@/lib/time";
import { evaluateTarget, type ScopeDecision } from "@/domain/lab/scope";
import { evidenceFromText } from "@/domain/lab/evidenceOps";
import { scopeDecisionLabel } from "@/features/lab/toolLabels";
import { useLabEngagement } from "@/features/lab/useLabEngagement";
import {
  builtinErrorKey,
  builtinTools,
  newRequestId,
  type ScopeAttestation,
} from "@/lib/builtinTools";

/* What every built-in tool panel shares: the line that says what leaves the
   machine and where it goes, the run and cancel button, the scope gate for
   tools that reach a target, the error sentence, and the result actions
   (copy, export, save to an investigation). Each tool lays out its own
   result. */

/** The route strip: what leaves this computer and where it goes. `local`
    tools say that nothing leaves. */
export function Destination({ local, children }: { local?: boolean; children?: ReactNode }) {
  const { t } = useT();
  return (
    <p className={`bt-route${local ? " bt-route--local" : ""}`}>
      {local ? <Lock size={13} aria-hidden /> : <ArrowRight size={13} aria-hidden />}
      <span className="bt-route__label">{t("builtin.dest.label")}</span>
      <span className="bt-route__text">{local ? t("builtin.dest.local") : children}</span>
    </p>
  );
}

export type Phase<T> =
  | { phase: "idle" }
  | { phase: "running"; id: string; since: number }
  | { phase: "done"; result: T }
  | { phase: "error"; error: unknown };

/** One request at a time, cancellable; a result from a request the user has
    since cancelled or replaced is dropped. */
export function useRequest<T>(tool: string) {
  const [state, setState] = useState<Phase<T>>({ phase: "idle" });
  const live = useRef<string | null>(null);
  const run = useCallback(
    async (work: (requestId: string) => Promise<T>) => {
      const id = newRequestId(tool);
      live.current = id;
      setState({ phase: "running", id, since: now() });
      try {
        const result = await work(id);
        if (live.current === id) setState({ phase: "done", result });
      } catch (error) {
        if (live.current === id) setState({ phase: "error", error });
      } finally {
        if (live.current === id) live.current = null;
      }
    },
    [tool],
  );
  const cancel = useCallback(() => {
    const id = live.current;
    if (!id) return;
    live.current = null;
    void builtinTools.cancel(id);
    setState({ phase: "error", error: "cancelled" });
  }, []);
  const reset = useCallback(() => {
    live.current = null;
    setState({ phase: "idle" });
  }, []);
  // A request still running when the panel closes is stopped.
  useEffect(
    () => () => {
      if (live.current) void builtinTools.cancel(live.current);
    },
    [],
  );
  return { state, run, cancel, reset };
}

/** Seconds since `since`, ticking while shown. */
export function Elapsed({ since }: { since: number }) {
  const { t } = useT();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="bt-elapsed" aria-live="off">
      {t("builtin.run.elapsed", { seconds: Math.max(0, Math.floor((now() - since) / 1000)) })}
    </span>
  );
}

/** Run, or while running, Stop with the time it has taken. */
export function RunButton({
  running,
  since,
  label,
  disabled,
  onCancel,
}: {
  running: boolean;
  since?: number;
  label: string;
  disabled?: boolean;
  onCancel: () => void;
}) {
  const { t } = useT();
  if (running) {
    return (
      <span className="bt-running">
        <span className="spin bt-running__spin" aria-hidden />
        <span role="status">{t("builtin.run.running")}</span>
        {since !== undefined && <Elapsed since={since} />}
        <button type="button" className="btn btn--secondary btn--sm" onClick={onCancel}>
          <Square size={11} aria-hidden /> {t("builtin.run.cancel")}
        </button>
      </span>
    );
  }
  return (
    <button type="submit" className="btn btn--primary btn--sm bt-run" disabled={disabled}>
      {label}
    </button>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const { t } = useT();
  const key = builtinErrorKey(error);
  const cancelled = error === "cancelled";
  return (
    <p className={`bt-note ${cancelled ? "bt-note--quiet" : "bt-note--error"}`} role="alert">
      {!cancelled && <TriangleAlert size={14} aria-hidden />}
      {t(key as BuiltinKey)}
    </p>
  );
}

/** The browser build has no Rust side: the form shows, the run cannot. */
export function DesktopOnly() {
  const { t } = useT();
  return <p className="bt-note bt-note--quiet">{t("builtin.desktopOnly")}</p>;
}

/* ---------------- Scope ---------------- */

export type Gate =
  | { ok: true; attestation: ScopeAttestation; decision: ScopeDecision }
  | { ok: false; decision: ScopeDecision | null };

/**
 * The investigation whose scope a network tool runs under — the one worked
 * on last unless the user picks another — and the decision for a target, by
 * the same rules every tool run follows (src/domain/lab/scope.ts). Rust
 * checks the decision again before anything is sent.
 */
export function useScopeGate() {
  const engagements = useCollection("engagements");
  const scopes = useCollection("authorizationScopes");
  const { current } = useLabEngagement(null);
  const [picked, setPicked] = useState<string | null>(null);
  const engagement = engagements.find((e) => e.id === (picked ?? current?.id)) ?? undefined;
  const scope = engagement?.scopeId ? scopes.find((s) => s.id === engagement.scopeId) : undefined;
  const open = useMemo(() => engagements.filter((e) => e.status !== "archived"), [engagements]);

  const decide = useCallback(
    (target: string): Gate => {
      const raw = target.trim();
      if (!raw) return { ok: false, decision: null };
      const decision = evaluateTarget(raw, scope);
      if (!decision.allowed) return { ok: false, decision };
      return {
        ok: true,
        decision,
        attestation: {
          scopeId: scope?.id ?? "",
          scopeRevision: scope?.revision ?? 0,
          target: raw,
          allowed: true,
          reason: decision.reason,
          decidedAt: now(),
          expiresAt: scope?.expiresAt,
        },
      };
    },
    [scope],
  );

  return { engagements: open, engagement, setEngagementId: setPicked, scope, decide };
}

/** Which investigation's scope applies, and what it says about the target. */
export function ScopeLine({
  gate,
  target,
}: {
  gate: ReturnType<typeof useScopeGate>;
  target: string;
}) {
  const { t } = useT();
  const verdict = target.trim() ? gate.decide(target) : null;
  return (
    <div className="bt-scope">
      <label className="bt-scope__pick">
        <span>{t("builtin.scope.label")}</span>
        <select
          className="input input--sm"
          value={gate.engagement?.id ?? ""}
          onChange={(event) => gate.setEngagementId(event.target.value || null)}
        >
          {gate.engagements.length === 0 && <option value="">{t("builtin.scope.none")}</option>}
          {gate.engagements.map((engagement) => (
            <option key={engagement.id} value={engagement.id}>
              {engagement.title}
            </option>
          ))}
        </select>
      </label>
      {verdict?.decision && (
        <span className={`bt-verdict ${verdict.ok ? "is-ok" : "is-blocked"}`} data-testid="scope-verdict">
          {verdict.ok ? <Check size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />}
          {scopeDecisionLabel(t, verdict.decision.reason)}
        </span>
      )}
      {!gate.scope && <span className="bt-scope__hint">{t("builtin.scope.localOnly")}</span>}
    </div>
  );
}

/* ---------------- Result actions ---------------- */

function download(fileName: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** A file name from the tool and the target, safe on every system. */
export function exportName(tool: string, target: string, at: number): string {
  const slug = target
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const day = new Date(at).toISOString().slice(0, 10);
  return `qutra-${tool}${slug ? `-${slug}` : ""}-${day}.json`;
}

/**
 * Copy the result as text, export it as JSON, or keep it in an investigation
 * as evidence (with where it came from). `sensitive` marks evidence that
 * names a person or a place.
 */
export function ResultActions({
  tool,
  target,
  text,
  data,
  title,
  engagementId,
  sensitive,
  saveable = true,
}: {
  tool: string;
  target: string;
  text: string;
  data: unknown;
  title: string;
  engagementId?: string;
  sensitive?: boolean;
  /** False for results that are no evidence (a key press). */
  saveable?: boolean;
}) {
  const { t } = useT();
  const toast = useUi((s) => s.toast);
  const engagements = useCollection("engagements");
  const { current } = useLabEngagement(null);
  const owner = engagements.find((e) => e.id === (engagementId ?? current?.id));
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ kind: "danger", message: t("builtin.actions.copyFailed") });
    }
  };
  const save = async () => {
    if (!owner) return;
    const evidence = await evidenceFromText({
      engagementId: owner.id,
      title,
      content: text,
      now: now(),
    });
    getDb()
      .collection("evidence")
      .put({ ...evidence, source: `builtin:${tool}`, sensitivity: sensitive ? "sensitive" : "normal" });
    setSaved(true);
    toast({ kind: "success", message: t("builtin.actions.saved", { title: owner.title }) });
  };

  return (
    <div className="bt-actions">
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copy()}>
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}{" "}
        {copied ? t("builtin.actions.copied") : t("builtin.actions.copy")}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => download(exportName(tool, target, now()), JSON.stringify(data, null, 2), "application/json")}
      >
        <Download size={13} aria-hidden /> {t("builtin.actions.export")}
      </button>
      {saveable && (
        <>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={!owner || saved}
            onClick={() => void save()}
          >
            {saved ? <Check size={13} aria-hidden /> : <FilePlus2 size={13} aria-hidden />}{" "}
            {saved ? t("builtin.actions.savedShort") : t("builtin.actions.save")}
          </button>
          <span className="bt-actions__to">
            {owner ? t("builtin.actions.saveTo", { title: owner.title }) : t("builtin.actions.saveNone")}
          </span>
        </>
      )}
    </div>
  );
}

/** A label and its value, in a definition list. Empty values are left out. */
export function Fact({
  label,
  value,
  mono,
  wide,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  /** Spans every column of a grid of facts (a hash, a policy). */
  wide?: boolean;
}) {
  if (value === "" || value === null || value === undefined) return null;
  return (
    <div className={wide ? "bt-fact bt-fact--wide" : "bt-fact"}>
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{value}</dd>
    </div>
  );
}

/** Dates as the reader's locale writes them; text that is no date stays. */
export function shownDate(value: string | number, locale: string): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}
