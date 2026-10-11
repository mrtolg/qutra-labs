import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  BridgeCapabilities,
  Capability,
  DesktopBridge,
  LaunchReceipt,
  MonitorInfo,
  NativeLocatedCandidate,
  NativeDetectedTool,
  NativeToolInstallation,
  NativeToolRun,
  NativeToolRunEvent,
  NativeToolSupervisor,
  RegisterNativeToolRequest,
  RestoreStepEvent,
  RunningAppInfo,
  SecureStore,
  SecureStoreResult,
  StartNativeToolRunRequest,
} from "./types";
import {
  TERMINAL_DATA_EVENT,
  TERMINAL_SESSION_EVENT,
  type ResolvedShellReport,
  type TerminalCloseAllReport,
  type TerminalController,
  type TerminalDataEvent,
  type TerminalScrollback,
  type TerminalSessionEvent,
  type TerminalSessionInfo,
  type TerminalSessionList,
} from "./terminal";
import type { SnapshotItem } from "@/domain/types";

const real: Capability = { available: true, simulated: false };
const unavailable = (reason: Capability["reason"]): Capability => ({
  available: false,
  simulated: false,
  reason,
});

interface NativeRunningApp {
  name: string;
  executable: string;
  window_title: string;
  monitor: number;
  x: number;
  y: number;
  w: number;
  h: number;
  elevated: boolean;
}

interface NativeMonitor {
  index: number;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
}

interface NativeRestoreOutcome {
  state: string;
  reason: string | null;
}

/**
 * Real OS credential-store bridge. Every call is a validated Rust command;
 * secret values are write-only from the UI's perspective and never logged.
 */
class TauriSecureStore implements SecureStore {
  available(): boolean {
    return true;
  }
  async set(key: string, value: string): Promise<SecureStoreResult> {
    try {
      await invoke("secure_set", { key, value });
      return { ok: true };
    } catch (err) {
      // err is a redacted code string from Rust; never contains the value.
      return { ok: false, reason: String(err) };
    }
  }
  async has(key: string): Promise<boolean> {
    return await invoke<boolean>("secure_has", { key });
  }
  async delete(key: string): Promise<SecureStoreResult> {
    try {
      await invoke("secure_delete", { key });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }
}

class TauriToolSupervisor implements NativeToolSupervisor {
  available(): boolean {
    return true;
  }

  async consentGranted(): Promise<boolean> {
    return invoke<boolean>("private_tools_consent");
  }

  async requestGrant(locale: string): Promise<boolean> {
    return invoke<boolean>("request_private_tools_grant", { locale });
  }

  async revoke(): Promise<void> {
    await invoke("revoke_private_tools_consent");
  }

  async locateCandidate(
    title: string,
    filterName: string,
  ): Promise<NativeLocatedCandidate | null> {
    return invoke<NativeLocatedCandidate | null>("locate_tool_candidate", {
      title,
      filterName,
    });
  }

  async detectInstallations(skipCatalogIds: string[]): Promise<NativeDetectedTool[]> {
    return invoke<NativeDetectedTool[]>("detect_tool_installations", { skipCatalogIds });
  }

  async register(
    request: RegisterNativeToolRequest,
  ): Promise<NativeToolInstallation> {
    return invoke<NativeToolInstallation>("register_tool_installation", {
      request,
    });
  }

  async listInstallations(): Promise<NativeToolInstallation[]> {
    return invoke<NativeToolInstallation[]>("list_tool_installations");
  }

  async reverify(
    id: string,
    acceptChangedIdentity: boolean,
  ): Promise<NativeToolInstallation> {
    return invoke<NativeToolInstallation>("reverify_tool_installation", {
      id,
      acceptChangedIdentity,
    });
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<NativeToolInstallation> {
    return invoke<NativeToolInstallation>("set_tool_installation_enabled", {
      id,
      enabled,
    });
  }

  async remove(id: string): Promise<void> {
    await invoke("remove_tool_installation", { id });
  }

  async start(request: StartNativeToolRunRequest): Promise<NativeToolRun> {
    return invoke<NativeToolRun>("start_tool_run", { request });
  }

  async cancel(runId: string): Promise<void> {
    await invoke("cancel_tool_run", { runId });
  }

  async emergencyStop(): Promise<number> {
    return invoke<number>("emergency_stop_tool_runs");
  }

  async listRuns(): Promise<NativeToolRun[]> {
    return invoke<NativeToolRun[]>("list_tool_runs");
  }

  async listActiveRuns(): Promise<NativeToolRun[]> {
    return invoke<NativeToolRun[]>("list_active_tool_runs");
  }

  async deleteArtifacts(runId: string): Promise<NativeToolRun> {
    return invoke<NativeToolRun>("delete_tool_run_artifacts", { runId });
  }

  async onEvent(
    listener: (event: NativeToolRunEvent) => void,
  ): Promise<() => void> {
    return listen<NativeToolRunEvent>("contextos://tool-run", (event) =>
      listener(event.payload),
    );
  }

  async launchDetached(
    installationId: string,
    args: string[],
  ): Promise<{ ok: boolean; reason?: string; receipt?: LaunchReceipt }> {
    // One operation id per attempt: Rust returns the recorded attempt for a
    // repeated id instead of spawning again.
    const operationId = crypto.randomUUID();
    let receipt: LaunchReceipt;
    try {
      receipt = await invoke<LaunchReceipt>("launch_tool_detached", {
        operationId,
        installationId,
        args,
      });
    } catch (err) {
      // No attempt was made. err is a stable code string from Rust
      // (private_tools_consent_required, launch_record_failed,
      // invalid_installation_id, ...) — never surfaced to the user as-is;
      // the caller maps known codes to translated copy and falls back to
      // a generic message for anything else.
      return { ok: false, reason: String(err) };
    }
    if (receipt.outcome === "launched") return { ok: true, receipt };
    // A failed receipt carries the refusal or spawn code (tool_disabled,
    // tool_identity_changed, elevation_required, spawn_failed, ...).
    return { ok: false, reason: receipt.reasonCode ?? receipt.outcome, receipt };
  }

  async listLaunches(limit?: number): Promise<LaunchReceipt[]> {
    return invoke<LaunchReceipt[]>("tool_launches_list", { limit: limit ?? null });
  }

  async onLaunch(listener: (receipt: LaunchReceipt) => void): Promise<() => void> {
    return listen<LaunchReceipt>("tool://launch", (event) => listener(event.payload));
  }
}

/**
 * Real terminal controller. Every method calls into the validated Rust PTY
 * commands; output arrives over the `terminal://data` event.
 */
function createTauriTerminal(): TerminalController {
  return {
    available: () => true,
    async resolvedShell() {
      return invoke<ResolvedShellReport>("terminal_resolved_shell");
    },
    async open(opts) {
      try {
        // The session's facts also arrive on `terminal://session`; a tab
        // only needs the id it now owns.
        const info = await invoke<TerminalSessionInfo>("terminal_open", {
          shell: opts.shell,
          cwd: opts.cwd ?? null,
          cols: opts.cols,
          rows: opts.rows,
        });
        return info.sessionId;
      } catch (err) {
        // err is a dynamic PTY/spawn diagnostic (`openpty:<os error>`,
        // `spawn:<os error>`) -- TerminalTab renders it to the user as-is
        // for shell tabs (there is no stable code to translate). Logged
        // here too (not swallowed) so field reports keep the raw detail
        // even if that rendering ever changes, mirroring `openTool` below.
        console.warn("terminal_open refused:", err);
        throw err;
      }
    },
    async openTool(opts) {
      try {
        const info = await invoke<TerminalSessionInfo>("terminal_open_tool", {
          installationId: opts.installationId,
          args: opts.args,
          cols: opts.cols,
          rows: opts.rows,
        });
        return info.sessionId;
      } catch (err) {
        // err is a stable code string from Rust (private_tools_consent_required,
        // tool_disabled, tool_identity_changed, tool_not_found,
        // tool_path_missing, working_directory_missing,
        // working_directory_not_folder) or a dynamic "spawn:<os error>"
        // message -- never surfaced to the user as-is; TerminalTab maps
        // known codes to translated copy via launchFailureMessage. Logged
        // here (not swallowed) so field reports keep the raw code even
        // though the UI only ever shows the translated string.
        console.warn("terminal_open_tool refused:", err);
        throw err;
      }
    },
    async write(id, data) {
      await invoke("terminal_write", { id, data });
    },
    async resize(id, cols, rows) {
      await invoke("terminal_resize", { id, cols, rows });
    },
    async close(id) {
      await invoke("terminal_close", { id });
    },
    async closeAll() {
      return invoke<TerminalCloseAllReport>("terminal_close_all");
    },
    async onData(listener) {
      return listen<TerminalDataEvent>(TERMINAL_DATA_EVENT, (e) => listener(e.payload));
    },
    async scrollback(id) {
      return invoke<TerminalScrollback>("terminal_scrollback", { id });
    },
    async listSessions() {
      return invoke<TerminalSessionList>("terminal_list_sessions");
    },
    async onSession(listener) {
      return listen<TerminalSessionEvent>(TERMINAL_SESSION_EVENT, (e) => listener(e.payload));
    },
  };
}

/**
 * Real native bridge. Every method calls into validated Rust commands or
 * scoped official plugins. Capabilities report `simulated: false`; anything
 * the native layer cannot do returns an honest unavailable state — never a
 * silent browser simulation.
 */
export class TauriBridge implements DesktopBridge {
  readonly mode = "tauri" as const;
  readonly secureStore: SecureStore = new TauriSecureStore();
  readonly toolSupervisor: NativeToolSupervisor = new TauriToolSupervisor();
  readonly terminal: TerminalController = createTauriTerminal();

  capabilities(): BridgeCapabilities {
    return {
      runningApps: real,
      windowBounds: real,
      launchApp: real,
      openUrl: real,
      openPath: real,
      pickPath: real,
      readClipboard: real,
      writeClipboard: real,
      gitInspection: unavailable("not_implemented"),
      globalShortcuts: real,
      notifications: real,
      secureStore: real,
      toolSupervisor: real,
      terminal: real,
    };
  }

  async listRunningApps(): Promise<RunningAppInfo[]> {
    const apps = await invoke<NativeRunningApp[]>("list_running_apps");
    return apps.map((a) => ({
      name: a.name,
      executable: a.executable,
      windowTitle: a.window_title,
      bounds: { monitor: a.monitor, x: a.x, y: a.y, w: a.w, h: a.h },
      elevated: a.elevated,
      singleInstance: false,
    }));
  }

  async listMonitors(): Promise<MonitorInfo[]> {
    const monitors = await invoke<NativeMonitor[]>("list_monitors");
    return monitors.map((m) => ({
      index: m.index,
      width: m.width,
      height: m.height,
      scale: m.scale,
    }));
  }

  restoreItems(
    items: SnapshotItem[],
    onEvent: (e: RestoreStepEvent) => void,
  ): { cancel: () => void } {
    let cancelled = false;

    const run = async () => {
      let anyFailure = false;
      for (const item of items) {
        if (cancelled) break;
        onEvent({ kind: "state", itemId: item.id, state: "launching" });
        try {
          const outcome = await invoke<NativeRestoreOutcome>("restore_item", {
            item: {
              kind: item.kind,
              title: item.title,
              target: item.target,
              args: [],
              window_bounds: item.windowBounds
                ? {
                    monitor: item.windowBounds.monitor,
                    x: item.windowBounds.x,
                    y: item.windowBounds.y,
                    w: item.windowBounds.w,
                    h: item.windowBounds.h,
                  }
                : null,
            },
          });
          if (cancelled) break;
          if (
            outcome.state === "failed" ||
            outcome.state === "permission_required"
          ) {
            anyFailure = true;
          }
          onEvent({
            kind: "state",
            itemId: item.id,
            state: outcome.state,
            reason: outcome.reason ?? undefined,
          });
        } catch (err) {
          anyFailure = true;
          onEvent({
            kind: "state",
            itemId: item.id,
            state: "failed",
            reason: String(err),
          });
        }
      }
      if (!cancelled) {
        onEvent({ kind: "done", status: anyFailure ? "partial" : "completed" });
      }
    };

    void run();
    return {
      cancel: () => {
        cancelled = true;
        onEvent({ kind: "done", status: "cancelled" });
      },
    };
  }

  /** Only the Rust command opens a URL: it accepts http(s) and nothing else,
      and the window holds no permission to open one by itself. */
  async openUrl(url: string): Promise<{ ok: boolean; simulated: boolean }> {
    try {
      await invoke("open_url_checked", { url });
      return { ok: true, simulated: false };
    } catch {
      return { ok: false, simulated: false };
    }
  }

  async openPath(path: string): Promise<{ ok: boolean; simulated: boolean }> {
    try {
      await invoke("open_path_checked", { path });
      return { ok: true, simulated: false };
    } catch {
      return { ok: false, simulated: false };
    }
  }

  async pickPath(options?: { directory?: boolean }): Promise<string | null> {
    const selected = await open({
      multiple: false,
      directory: Boolean(options?.directory),
      title: options?.directory ? "Select a folder" : "Select a file",
    });
    if (!selected || Array.isArray(selected)) return null;
    return selected;
  }

  async writeClipboard(text: string): Promise<{ ok: boolean }> {
    try {
      await writeText(text);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async notify(
    title: string,
    body: string,
  ): Promise<{ ok: boolean; simulated: boolean }> {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === "granted";
      }
      if (!granted) return { ok: false, simulated: false };
      sendNotification({ title, body });
      return { ok: true, simulated: false };
    } catch {
      return { ok: false, simulated: false };
    }
  }

  async abandonPreviousRenderer(): Promise<{
    cancelledTurn: boolean;
    closedSessions: number;
  }> {
    return invoke("abandon_previous_renderer");
  }
}
