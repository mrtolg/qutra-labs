import { useEffect, useState } from "react";
import { AlertTriangle, FileOutput, PanelBottomOpen, Square } from "lucide-react";
import type { OutputKind } from "@/domain/tools/toolForms";
import type { NativeToolRun } from "@/lib/bridge/types";
import { useT } from "@/lib/i18n";
import { useToolFormsT } from "@/lib/i18n/toolForms";
import { toolFormRuns } from "@/lib/toolForms";
import { useLabRuntime } from "@/state/labRuntime";
import { runStateLabel } from "./labels";
import { formRunError } from "./ToolFormRunner";
import { parseToolOutput, stripAnsi, type ParsedOutput } from "./toolOutput";

const ACTIVE = ["queued", "starting", "running", "cancelling"];
const NO_LINES: never[] = [];

type Loaded =
  | { status: "loading" }
  | { status: "ready"; stdout: string; stderr: string }
  | { status: "failed"; reason: string };

function seconds(run: NativeToolRun, at: number): string {
  const start = run.startedAt ?? run.createdAt;
  const end = run.endedAt ?? at;
  return Math.max(0, (end - start) / 1000).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  });
}

/**
 * The result of the tool's last form run, read the way its preset says: a
 * port table for Nmap, a table for CSV and JSON lists,
 * fields for a single record, lines for a list, the text otherwise. The raw
 * output is one click away, and the run's full log stays in the output panel.
 */
export function ToolRunResult({
  run,
  output,
  outputName,
  toolName,
  onStop,
  onShowOutput,
}: {
  run: NativeToolRun;
  toolName: string;
  output: OutputKind;
  outputName?: string | null;
  onStop: () => void;
  onShowOutput: () => void;
}) {
  const { t, locale } = useT();
  const tf = useToolFormsT();
  const active = ACTIVE.includes(run.state);
  const lines = useLabRuntime((s) => s.logs[run.id] ?? NO_LINES);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [raw, setRaw] = useState(false);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (active || run.state === "blocked") return;
    let live = true;
    setLoaded({ status: "loading" });
    Promise.all([
      run.bytesOut > 0 ? toolFormRuns.output(run.id, "stdout.log") : Promise.resolve(""),
      run.bytesErr > 0 ? toolFormRuns.output(run.id, "stderr.log") : Promise.resolve(""),
    ])
      .then(([stdout, stderr]) => live && setLoaded({ status: "ready", stdout, stderr }))
      .catch((caught: unknown) => {
        // The ledger's tail is the fallback when the log cannot be read.
        if (!live) return;
        if (run.stdoutTail || run.stderrTail) {
          setLoaded({ status: "ready", stdout: run.stdoutTail, stderr: run.stderrTail });
        } else {
          setLoaded({ status: "failed", reason: String(caught) });
        }
      });
    return () => {
      live = false;
    };
  }, [active, run.id, run.state, run.bytesOut, run.bytesErr, run.stdoutTail, run.stderrTail]);

  const failed = ["failed", "timed_out", "orphaned", "blocked"].includes(run.state);
  const tone = active ? "running" : failed ? "bad" : run.state === "cancelled" ? "muted" : "good";
  const parsed: ParsedOutput | null =
    loaded.status === "ready" ? parseToolOutput(output, loaded.stdout) : null;

  return (
    <div className={`wb-result wb-result--${tone}`} data-testid="wb-result">
      <header className="wb-result__head">
        <span className={`wb-state wb-state--${tone}`}>{runStateLabel(t, run.state)}</span>
        <span className="wb-result__meta">
          {t("lab.wb.elapsed", { seconds: seconds(run, clock) })}
          {run.exitCode !== undefined && run.exitCode !== null
            ? ` · ${t("lab.wb.exit", { code: run.exitCode })}`
            : ""}
          {" · "}
          {new Date(run.createdAt).toLocaleTimeString(locale)}
        </span>
        <span className="lab-grow" />
        {active ? (
          <button type="button" className="btn btn--danger btn--sm" onClick={onStop}>
            <Square size={12} aria-hidden /> {t("lab.tools.stop")}
          </button>
        ) : (
          loaded.status === "ready" && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-pressed={raw}
              onClick={() => setRaw((value) => !value)}
            >
              {raw ? t("lab.wb.structured") : t("lab.wb.raw")}
            </button>
          )
        )}
        <button type="button" className="btn btn--ghost btn--sm" onClick={onShowOutput}>
          <PanelBottomOpen size={13} aria-hidden /> {t("panel.showOutput")}
        </button>
      </header>

      {outputName && !failed && !active && (
        <p className="wb-note">
          <FileOutput size={13} aria-hidden /> {t("lab.wb.savedFile", { name: outputName })}
        </p>
      )}

      {active && (
        <pre className="wb-live" aria-live="polite">
          {lines.length > 0
            ? lines
                .slice(-8)
                .map((line) => stripAnsi(line.text))
                .join("\n")
            : t("lab.wb.waiting")}
        </pre>
      )}

      {run.state === "blocked" && (
        <p className="wb-note wb-note--danger">
          <AlertTriangle size={14} aria-hidden />{" "}
          {t("lab.wb.blockedRun", {
            reason: formRunError(t, tf, run.blockedReason || run.terminationReason, toolName),
          })}
        </p>
      )}

      {!active && run.state !== "blocked" && loaded.status === "loading" && (
        <p className="wb-note">{t("lab.wb.loadingOutput")}</p>
      )}
      {loaded.status === "failed" && (
        <p className="wb-note wb-note--danger">{t("lab.wb.outputError")}</p>
      )}

      {loaded.status === "ready" && (
        <>
          {failed && loaded.stderr.trim() && (
            <pre className="wb-stderr">{stripAnsi(loaded.stderr).trim().split(/\r?\n/).slice(0, 12).join("\n")}</pre>
          )}
          {raw ? (
            <pre className="wb-raw">{stripAnsi(loaded.stdout || loaded.stderr) || t("lab.wb.empty")}</pre>
          ) : (
            parsed && <OutputView parsed={parsed} stderr={loaded.stderr} failed={failed} />
          )}
        </>
      )}
    </div>
  );
}

function Count({ shown, total }: { shown: number; total: number }) {
  const { t } = useT();
  if (shown >= total) return null;
  return <p className="wb-note">{t("lab.wb.rows", { shown, total })}</p>;
}

function OutputView({
  parsed,
  stderr,
  failed,
}: {
  parsed: ParsedOutput;
  stderr: string;
  failed: boolean;
}) {
  const { t } = useT();
  switch (parsed.kind) {
    case "empty":
      return failed ? null : (
        <p className="wb-note">
          {stderr.trim() ? stripAnsi(stderr).trim().split(/\r?\n/)[0] : t("lab.wb.empty")}
        </p>
      );
    case "nmap": {
      const up = parsed.hosts.filter((host) => host.status !== "down");
      const open = up.flatMap((host) =>
        host.ports.filter((port) => port.state === "open").map((port) => ({ host, port })),
      );
      return (
        <>
          <p className="wb-result__lead">
            {t("lab.wb.hosts", { count: up.length })} · {t("lab.wb.openPorts", { count: open.length })}
            {parsed.summary ? <small> — {parsed.summary}</small> : null}
          </p>
          {up.length === 0 ? (
            <p className="wb-note">{t("lab.wb.noHosts")}</p>
          ) : (
            <div className="wb-table-wrap">
              <table className="wb-table">
                <thead>
                  <tr>
                    <th scope="col">{t("lab.wb.col.host")}</th>
                    <th scope="col">{t("lab.wb.col.port")}</th>
                    <th scope="col">{t("lab.wb.col.state")}</th>
                    <th scope="col">{t("lab.wb.col.service")}</th>
                    <th scope="col">{t("lab.wb.col.version")}</th>
                  </tr>
                </thead>
                <tbody>
                  {up.flatMap((host) =>
                    host.ports.length === 0
                      ? [
                          <tr key={host.address}>
                            <td className="mono">{host.address}{host.name ? ` (${host.name})` : ""}</td>
                            <td colSpan={4} className="wb-muted">{t("lab.wb.hostUp")}</td>
                          </tr>,
                        ]
                      : host.ports.map((port) => (
                          <tr key={`${host.address}-${port.protocol}-${port.port}`}>
                            <td className="mono">{host.address}</td>
                            <td className="mono">{port.port}/{port.protocol}</td>
                            <td>
                              <span className={`wb-port wb-port--${port.state === "open" ? "open" : "other"}`}>
                                {port.state}
                              </span>
                            </td>
                            <td>{port.service}</td>
                            <td>{port.version}</td>
                          </tr>
                        )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      );
    }
    case "table":
      return (
        <>
          {parsed.title && <p className="wb-result__lead">{parsed.title}</p>}
          <div className="wb-table-wrap">
            <table className="wb-table">
              <thead>
                <tr>
                  {parsed.columns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((value, column) => (
                      <td key={column} title={value.length > 80 ? value : undefined}>
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Count shown={parsed.rows.length} total={parsed.total} />
        </>
      );
    case "pairs":
      return (
        <dl className="wb-pairs">
          {parsed.pairs.map(([key, value], index) => (
            <div key={`${key}-${index}`}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      );
    case "lines":
      return (
        <>
          <ol className="wb-lines">
            {parsed.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ol>
          <Count shown={parsed.lines.length} total={parsed.total} />
        </>
      );
    case "text":
      return <pre className="wb-raw">{parsed.text}</pre>;
  }
}
