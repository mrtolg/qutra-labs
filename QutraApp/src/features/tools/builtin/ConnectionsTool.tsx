import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { useT } from "./i18n";
import type { BuiltinKey } from "./i18n";
import { builtinTools, type Connection, type ConnectionSnapshot } from "@/lib/builtinTools";
import { Destination, DesktopOnly, ErrorNote, ResultActions, useRequest } from "./shared";
import { CONN_STATES, connectionsText, wordOr } from "./summaries";

/* Connection and PID monitor: this machine's TCP and UDP tables as a dense,
   filterable list. Listening ports come first; one bound to every interface
   is marked, since it answers from the network and not only from here. */

const MAX_ROWS = 400;
type View = "all" | "listening" | "connected";
type Protocol = "all" | "tcp" | "udp";

const EVERY_INTERFACE = new Set(["0.0.0.0", "::"]);

export function matches(row: Connection, view: View, protocol: Protocol, query: string): boolean {
  if (protocol !== "all" && row.protocol !== protocol) return false;
  if (view === "listening" && row.state !== "listen" && row.state !== "bound") return false;
  if (view === "connected" && row.state !== "established") return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.localAddress, String(row.localPort), row.remoteAddress, String(row.remotePort), String(row.pid), row.process, row.state]
    .some((value) => value.toLowerCase().includes(q));
}

function address(addr: string, port: number, family: 4 | 6): string {
  if (!addr) return "";
  return family === 6 ? `[${addr}]:${port}` : `${addr}:${port}`;
}

export function ConnectionsTool() {
  const { t, locale } = useT();
  const request = useRequest<ConnectionSnapshot>("conns");
  const [view, setView] = useState<View>("all");
  const [protocol, setProtocol] = useState<Protocol>("all");
  const [query, setQuery] = useState("");
  const available = builtinTools.available();
  const { run } = request;

  const refresh = useCallback(() => {
    void run(() => builtinTools.connections());
  }, [run]);

  useEffect(() => {
    if (available) refresh();
  }, [available, refresh]);

  const state = request.state;
  const [last, setLast] = useState<ConnectionSnapshot | null>(null);
  useEffect(() => {
    if (state.phase === "done") setLast(state.result);
  }, [state]);

  const rows = useMemo(
    () => (last ? last.connections.filter((row) => matches(row, view, protocol, query)) : []),
    [last, view, protocol, query],
  );
  const counts = useMemo(() => {
    const all = last?.connections ?? [];
    return {
      listening: all.filter((r) => r.state === "listen").length,
      connected: all.filter((r) => r.state === "established").length,
      processes: new Set(all.map((r) => r.pid)).size,
    };
  }, [last]);

  return (
    <div className="bt-tool bt-conns">
      <Destination local />
      <div className="bt-toolbar">
        <div className="segmented" role="group" aria-label={t("builtin.conns.view")}>
          {(["all", "listening", "connected"] as View[]).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} className={view === v ? "is-active" : undefined} onClick={() => setView(v)}>
              {t(`builtin.conns.view.${v}` as BuiltinKey)}
            </button>
          ))}
        </div>
        <label className="bt-inline-field">
          <span>{t("builtin.conns.protocol")}</span>
          <select className="input input--sm" value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
            <option value="all">TCP + UDP</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
        </label>
        <label className="bt-inline-field bt-grow">
          <span className="sr-only">{t("builtin.conns.filter")}</span>
          <span className="bt-search">
            <Search size={13} aria-hidden />
            <input
              className="input input--sm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("builtin.conns.filterPlaceholder")}
              aria-label={t("builtin.conns.filter")}
            />
          </span>
        </label>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={refresh}
          disabled={!available || state.phase === "running"}
        >
          <RefreshCw size={13} aria-hidden className={state.phase === "running" ? "spin" : undefined} /> {t("builtin.conns.refresh")}
        </button>
      </div>

      {!available && <DesktopOnly />}
      {state.phase === "error" && <ErrorNote error={state.error} />}
      {last && !last.supported && <p className="bt-note bt-note--quiet">{t("builtin.conns.unsupported")}</p>}
      {available && !last && state.phase === "running" && (
        <div className="bt-loading" role="status">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="sr-only">{t("builtin.run.running")}</span>
        </div>
      )}

      {last && last.supported && (
        <>
          <p className="bt-summary-line">
            <span><strong>{counts.listening}</strong> {t("builtin.conns.countListening")}</span>
            <span><strong>{counts.connected}</strong> {t("builtin.conns.countConnected")}</span>
            <span><strong>{counts.processes}</strong> {t("builtin.conns.countProcesses")}</span>
            <span className="bt-summary-line__time">
              {t("builtin.conns.takenAt", { time: new Date(last.takenAt).toLocaleTimeString(locale) })}
            </span>
          </p>
          {rows.length === 0 ? (
            <p className="bt-empty">{t("builtin.conns.noMatch")}</p>
          ) : (
            <div className="table-wrap bt-table-wrap bt-conns__table">
              <table className="table bt-table">
                <thead>
                  <tr>
                    <th>{t("builtin.conns.col.protocol")}</th>
                    <th>{t("builtin.conns.col.local")}</th>
                    <th>{t("builtin.conns.col.remote")}</th>
                    <th>{t("builtin.conns.col.state")}</th>
                    <th className="bt-num">PID</th>
                    <th>{t("builtin.conns.col.process")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, MAX_ROWS).map((row, i) => {
                    const listening = row.state === "listen" || row.state === "bound";
                    const open = listening && EVERY_INTERFACE.has(row.localAddress);
                    return (
                      <tr key={`${row.protocol}-${row.localAddress}-${row.localPort}-${row.remoteAddress}-${row.remotePort}-${row.pid}-${i}`} className={listening ? "is-listening" : undefined}>
                        <td className="mono">{row.protocol.toUpperCase()}{row.family === 6 ? "6" : ""}</td>
                        <td className="mono">
                          {address(row.localAddress, row.localPort, row.family)}
                          {open && <span className="bt-flag" title={t("builtin.conns.everyInterfaceHint")}>{t("builtin.conns.everyInterface")}</span>}
                        </td>
                        <td className="mono">{address(row.remoteAddress, row.remotePort, row.family) || "—"}</td>
                        <td>{wordOr(t, "builtin.conns.state", row.state, CONN_STATES)}</td>
                        <td className="bt-num mono">{row.pid}</td>
                        <td>{row.process || <span className="faint">{t("builtin.conns.unknownProcess")}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > MAX_ROWS && (
            <p className="bt-note bt-note--quiet">{t("builtin.conns.more", { count: rows.length - MAX_ROWS })}</p>
          )}
          <ResultActions
            tool="conns"
            target="localhost"
            text={connectionsText(rows)}
            data={rows}
            title={t("builtin.conns.evidenceTitle", { count: rows.length })}
          />
        </>
      )}
    </div>
  );
}
