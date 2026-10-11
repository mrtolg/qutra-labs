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
import { createBrowserTerminal, type TerminalController } from "./terminal";
import { e2eTools } from "@/lib/e2eTools";
import type { SnapshotItem } from "@/domain/types";

const sim: Capability = { available: true, simulated: true, reason: "browser_mode" };
const unavailable: Capability = {
  available: false,
  simulated: false,
  reason: "browser_mode",
};

/**
 * Deterministic browser/demo implementation.
 * Restore timing and outcomes are seeded from item ids so Playwright
 * tests and screenshots are reproducible.
 */
/**
 * Browser/demo secure store. There is no OS credential store in a browser, so
 * this NEVER persists a secret (localStorage would be an insecure fake). It
 * reports unavailable honestly; the GitHub demo flow uses fixtures instead of
 * real tokens.
 */
class BrowserSecureStore implements SecureStore {
  available(): boolean {
    return false;
  }
  async set(): Promise<SecureStoreResult> {
    return { ok: false, reason: "browser_mode" };
  }
  async has(): Promise<boolean> {
    return false;
  }
  async delete(): Promise<SecureStoreResult> {
    // Nothing is ever stored, so delete is trivially successful.
    return { ok: true };
  }
}

class BrowserToolSupervisor implements NativeToolSupervisor {
  /** False unless an end-to-end test page supplied a fake supervisor
      (development builds only, see `e2eTools`). */
  available(): boolean {
    return Boolean(e2eTools());
  }
  private unavailable(): never {
    throw new Error("native_tool_execution_unavailable");
  }
  /**
   * There is no native surface to consent to in a browser, so this is always
   * denied and granting is a no-op that still reports denied. Reporting `true`
   * here would be a lie that makes the demo build look authorized.
   */
  async consentGranted(): Promise<boolean> {
    // An e2e page's fake supervisor stands for a granted one (dev only).
    return Boolean(e2eTools());
  }
  async requestGrant(): Promise<boolean> {
    return false;
  }
  async revoke(): Promise<void> {}
  async locateCandidate(): Promise<NativeLocatedCandidate | null> {
    return this.unavailable();
  }
  async detectInstallations(skipCatalogIds: string[]): Promise<NativeDetectedTool[]> {
    return e2eTools()?.detect?.(skipCatalogIds) ?? [];
  }
  async register(
    _request: RegisterNativeToolRequest,
  ): Promise<NativeToolInstallation> {
    return this.unavailable();
  }
  async listInstallations(): Promise<NativeToolInstallation[]> {
    return e2eTools()?.installations ?? [];
  }
  async reverify(): Promise<NativeToolInstallation> {
    return this.unavailable();
  }
  async setEnabled(id: string, enabled: boolean): Promise<NativeToolInstallation> {
    const seam = e2eTools();
    return seam?.setEnabled ? seam.setEnabled(id, enabled) : this.unavailable();
  }
  async remove(): Promise<void> {
    return this.unavailable();
  }
  async start(_request: StartNativeToolRunRequest): Promise<NativeToolRun> {
    return this.unavailable();
  }
  async cancel(): Promise<void> {
    return this.unavailable();
  }
  async emergencyStop(): Promise<number> {
    return this.unavailable();
  }
  async listRuns(): Promise<NativeToolRun[]> {
    return e2eTools()?.runs ?? [];
  }
  async listActiveRuns(): Promise<NativeToolRun[]> {
    return [];
  }
  async deleteArtifacts(): Promise<NativeToolRun> {
    return this.unavailable();
  }
  async onEvent(
    listener: (event: NativeToolRunEvent) => void,
  ): Promise<() => void> {
    e2eTools()?.onEvent?.(listener);
    return () => undefined;
  }
  /**
   * A browser build cannot launch a detached native process. Honest failure
   * — never a throw and never a simulated success — matching the rest of
   * this stub's "browser mode launches nothing" contract. `reason` matches
   * the code the caller uses everywhere else in this stub.
   */
  async launchDetached(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: false, reason: "browser_mode" };
  }
  /** Nothing was launched here, so there is nothing to have recorded. */
  async listLaunches(): Promise<LaunchReceipt[]> {
    return [];
  }
  async onLaunch(): Promise<() => void> {
    return () => undefined;
  }
}

export class BrowserBridge implements DesktopBridge {
  readonly mode = "browser" as const;
  readonly secureStore: SecureStore = new BrowserSecureStore();
  readonly toolSupervisor: NativeToolSupervisor = new BrowserToolSupervisor();
  readonly terminal: TerminalController = createBrowserTerminal();

  capabilities(): BridgeCapabilities {
    return {
      runningApps: sim,
      windowBounds: sim,
      launchApp: sim,
      openUrl: { available: true, simulated: false },
      openPath: unavailable,
      pickPath: unavailable,
      readClipboard: {
        available:
          typeof navigator !== "undefined" && !!navigator.clipboard,
        simulated: false,
      },
      writeClipboard: {
        available:
          typeof navigator !== "undefined" && !!navigator.clipboard,
        simulated: false,
      },
      gitInspection: sim,
      globalShortcuts: unavailable,
      notifications: sim,
      secureStore: unavailable,
      toolSupervisor: unavailable,
      terminal: unavailable,
    };
  }

  async listRunningApps(): Promise<RunningAppInfo[]> {
    return [
      {
        name: "Visual Studio Code",
        executable: "C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
        windowTitle: "contextos — Visual Studio Code",
        bounds: { monitor: 0, x: 0, y: 0, w: 1280, h: 1040 },
        elevated: false,
        singleInstance: false,
      },
      {
        name: "Windows Terminal",
        executable: "wt.exe",
        windowTitle: "PowerShell — contextos",
        bounds: { monitor: 1, x: 1920, y: 60, w: 960, h: 640 },
        elevated: false,
        singleInstance: true,
      },
      {
        name: "Firefox",
        executable: "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
        windowTitle: "Tauri 2 docs — Mozilla Firefox",
        bounds: { monitor: 1, x: 1920, y: 0, w: 1920, h: 1080 },
        elevated: false,
        singleInstance: false,
      },
      {
        name: "Visual Studio Code",
        executable: "C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
        windowTitle: "Qutra Labs — Visual Studio Code",
        bounds: { monitor: 0, x: 200, y: 120, w: 1100, h: 800 },
        elevated: false,
        singleInstance: true,
      },
    ];
  }

  async listMonitors(): Promise<MonitorInfo[]> {
    return [
      { index: 0, width: 1920, height: 1080, scale: 1.25 },
      { index: 1, width: 2560, height: 1440, scale: 1 },
    ];
  }

  restoreItems(
    items: SnapshotItem[],
    onEvent: (e: RestoreStepEvent) => void,
  ): { cancel: () => void } {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Deterministic pseudo-random per item id.
    const hash = (s: string) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return Math.abs(h);
    };

    const run = async () => {
      let anyFailure = false;
      for (const item of items) {
        if (cancelled) break;
        const h = hash(item.id + item.title);
        const stepMs = 260 + (h % 240);

        const step = (state: string, reason?: string) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              if (!cancelled) onEvent({ kind: "state", itemId: item.id, state, reason });
              resolve();
            }, stepMs);
            timers.push(timer);
          });

        await step("launching");
        if (cancelled) break;

        // Deterministic outcome distribution:
        // target containing "missing" → failed; "elevated" → permission_required;
        // ~1 in 9 → failed (missing executable); rest restored.
        if (item.target.includes("missing") || item.detail.includes("missing")) {
          anyFailure = true;
          await step("failed", "missing_executable");
          continue;
        }
        if (item.target.includes("elevated") || item.detail.includes("admin")) {
          anyFailure = true;
          await step("permission_required", "elevation_required");
          continue;
        }
        await step("waiting");
        if (cancelled) break;
        if (item.kind === "app" || item.windowBounds) {
          await step("repositioning");
          if (cancelled) break;
        }
        if (h % 9 === 3) {
          anyFailure = true;
          await step("failed", "timeout");
        } else {
          await step("restored");
        }
      }
      if (!cancelled) {
        onEvent({
          kind: "done",
          status: anyFailure ? "partial" : "completed",
        });
      }
    };

    void run();

    return {
      cancel: () => {
        cancelled = true;
        timers.forEach(clearTimeout);
        onEvent({ kind: "done", status: "cancelled" });
      },
    };
  }

  async openUrl(url: string): Promise<{ ok: boolean; simulated: boolean }> {
    try {
      window.open(url, "_blank", "noopener,noreferrer");
      return { ok: true, simulated: false };
    } catch {
      return { ok: false, simulated: false };
    }
  }

  async openPath(): Promise<{ ok: boolean; simulated: boolean }> {
    // Browsers cannot open local paths; report honestly.
    return { ok: false, simulated: false };
  }

  async pickPath(): Promise<string | null> {
    return null;
  }

  async writeClipboard(text: string): Promise<{ ok: boolean }> {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async notify(): Promise<{ ok: boolean; simulated: boolean }> {
    // In-app toast is used instead; native notification is simulated.
    return { ok: true, simulated: true };
  }

  async abandonPreviousRenderer(): Promise<{
    cancelledTurn: boolean;
    closedSessions: number;
  }> {
    return { cancelledTurn: false, closedSessions: 0 };
  }
}
