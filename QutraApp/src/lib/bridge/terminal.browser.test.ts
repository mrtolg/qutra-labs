import { describe, expect, it, vi } from "vitest";
import { createBrowserTerminal } from "./terminal";

describe("browser terminal controller", () => {
  it("is honestly unavailable and never fabricates a session", async () => {
    const term = createBrowserTerminal();
    expect(term.available()).toBe(false);
    await expect(term.resolvedShell()).rejects.toThrow(/browser_mode/);
    await expect(term.open({ shell: "pwsh", cols: 80, rows: 24 })).rejects.toThrow(
      /browser_mode/,
    );
    const off = await term.onData(() => {});
    expect(typeof off).toBe("function");
    expect(await term.closeAll()).toEqual({ requested: 0, failed: [] });
  });

  it("openTool is honestly unavailable in the browser", async () => {
    const term = createBrowserTerminal();
    await expect(
      term.openTool({ installationId: "installation-1", args: [], cols: 80, rows: 24 }),
    ).rejects.toThrow(/browser_mode/);
  });

  it("scrollback is an honest empty snapshot, never a fabricated one", async () => {
    const term = createBrowserTerminal();
    await expect(term.scrollback("anything")).resolves.toEqual({ text: "", cursor: 0 });
  });

  it("lists no sessions and never emits one", async () => {
    const term = createBrowserTerminal();
    await expect(term.listSessions()).resolves.toEqual({
      runtimeId: "browser",
      revision: 0,
      sessions: [],
    });
    const listener = vi.fn();
    const off = await term.onSession(listener);
    expect(typeof off).toBe("function");
    expect(listener).not.toHaveBeenCalled();
  });
});
