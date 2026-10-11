import { getBridge } from "@/lib/bridge";
import type { TerminalCloseAllReport } from "@/lib/bridge/terminal";
import { useUi } from "@/state/ui";
import { useTerminalTabs } from "./terminalTabs";

/**
 * Close every managed PTY and drop the tab records that would relaunch
 * them. Private Lab revoke and a retained Terminal owner dying both use
 * this: neither can depend on `TerminalPage` having mounted. Retrying a
 * failed page must not spawn a registered tool under an old tab identity.
 */
export async function closeManagedTerminals(): Promise<TerminalCloseAllReport | null> {
  useTerminalTabs.getState().invalidateAll();
  const terminal = getBridge().terminal;
  if (!terminal.available()) return { requested: 0, failed: [] };
  let report: TerminalCloseAllReport;
  try {
    report = await terminal.closeAll();
    if (!Array.isArray(report?.failed)) throw new Error("terminal_close_all: unexpected reply");
  } catch (error) {
    // Every caller fires and forgets, so this is where it gets said.
    console.warn("terminal_close_all failed:", error);
    useUi.getState().toast({ kind: "danger", messageKey: "terminal.stopAllFailed" });
    return null;
  }
  // A session that would not stop stays listed as running in Rust; say so
  // rather than let Stop all look done.
  if (report.failed.length > 0) {
    useUi.getState().toast({
      kind: "danger",
      messageKey: "terminal.stopFailed",
      params: { count: report.failed.length },
    });
  }
  return report;
}
