import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalTabs } from "./terminalTabs";

const reset = () =>
  useTerminalTabs.setState({ tabs: [], activeId: null, reseedAllowed: true });

describe("terminal tab store", () => {
  beforeEach(reset);

  it("titles a default tab with the resolved program without changing the spec", () => {
    const id = useTerminalTabs.getState().openShellTab("pwsh", "powershell.exe");
    const tab = useTerminalTabs.getState().tabs.find((t) => t.id === id)!;
    expect(tab.title).toBe("powershell.exe");
    expect(tab.spec).toEqual({ kind: "shell", shell: "pwsh" });
  });

  it("opens a shell tab and makes it active", () => {
    const id = useTerminalTabs.getState().openShellTab("bash");
    const s = useTerminalTabs.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(id);
    expect(s.tabs[0].spec).toEqual({ kind: "shell", shell: "bash" });
  });

  it("opens a tool tab naming an installation id, never a path or a working directory (interactive launch route)", () => {
    const id = useTerminalTabs.getState().openToolTab({
      installationId: "installation-1", args: ["--target", "example.com"], title: "Test Tool",
    });
    const tab = useTerminalTabs.getState().tabs.find((t) => t.id === id)!;
    expect(tab.title).toBe("Test Tool");
    expect(tab.spec).toEqual({
      kind: "tool",
      installationId: "installation-1",
      args: ["--target", "example.com"],
    });
    expect(useTerminalTabs.getState().activeId).toBe(id);
  });

  it("opens an attached tab naming an already-open session id, without asking the bridge to open anything", () => {
    const id = useTerminalTabs.getState().openAttachedTab({
      sessionId: "sess-42",
      title: "Assistant terminal",
    });
    const tab = useTerminalTabs.getState().tabs.find((t) => t.id === id)!;
    expect(tab.title).toBe("Assistant terminal");
    expect(tab.spec).toEqual({ kind: "attached", sessionId: "sess-42" });
    expect(useTerminalTabs.getState().activeId).toBe(id);
  });

  it("closing the active tab activates the previous remaining tab", () => {
    const a = useTerminalTabs.getState().openShellTab();
    const b = useTerminalTabs.getState().openShellTab();
    useTerminalTabs.getState().closeTab(b);
    expect(useTerminalTabs.getState().activeId).toBe(a);
    useTerminalTabs.getState().closeTab(a);
    expect(useTerminalTabs.getState().activeId).toBeNull();
    expect(useTerminalTabs.getState().tabs).toHaveLength(0);
  });

  it("reuses the tab already attached to a session instead of opening a second", () => {
    // The agent reuses a PTY across steps, so the same sessionId comes back on
    // more than one tool_result. Two tabs on one PTY is a data-loss trap:
    // closing either kills the session the other still shows as live.
    const first = useTerminalTabs
      .getState()
      .openAttachedTab({ sessionId: "sess-1", title: "Assistant terminal" });
    const other = useTerminalTabs.getState().openShellTab();

    const again = useTerminalTabs
      .getState()
      .openAttachedTab({ sessionId: "sess-1", title: "Assistant terminal" });

    expect(again).toBe(first);
    expect(useTerminalTabs.getState().tabs).toHaveLength(2);
    // Reusing it still brings it forward -- the user is being shown a result.
    expect(useTerminalTabs.getState().activeId).toBe(first);
    expect(other).not.toBe(first);
  });

  it("still opens a separate tab for a genuinely different session", () => {
    const a = useTerminalTabs
      .getState()
      .openAttachedTab({ sessionId: "sess-1", title: "Assistant terminal" });
    const b = useTerminalTabs
      .getState()
      .openAttachedTab({ sessionId: "sess-2", title: "Assistant terminal" });

    expect(b).not.toBe(a);
    expect(useTerminalTabs.getState().tabs).toHaveLength(2);
  });

  it("closing a non-active tab leaves the active tab unchanged", () => {
    const a = useTerminalTabs.getState().openShellTab();
    const b = useTerminalTabs.getState().openShellTab();
    expect(useTerminalTabs.getState().activeId).toBe(b);

    useTerminalTabs.getState().closeTab(a);

    expect(useTerminalTabs.getState().activeId).toBe(b);
    expect(useTerminalTabs.getState().tabs).toHaveLength(1);
  });

  it("invalidateAll drops tab records and refuses auto-reseed", () => {
    useTerminalTabs.getState().openToolTab({
      installationId: "installation-ugly-uuid",
      args: ["--target", "example.com"],
      title: "nmap",
    });
    useTerminalTabs.getState().invalidateAll();
    expect(useTerminalTabs.getState().tabs).toHaveLength(0);
    expect(useTerminalTabs.getState().activeId).toBeNull();
    expect(useTerminalTabs.getState().reseedAllowed).toBe(false);
  });

  it("binds a tab to the session it shows, so Work can read that session's facts", () => {
    const id = useTerminalTabs.getState().openShellTab("pwsh", "pwsh.exe");
    expect(useTerminalTabs.getState().tabs[0]!.sessionId).toBeUndefined();

    useTerminalTabs.getState().bindSession(id, "sess-7");
    expect(useTerminalTabs.getState().tabs[0]!.sessionId).toBe("sess-7");

    // A tab that is already gone stays gone.
    useTerminalTabs.getState().bindSession("no-such-tab", "sess-8");
    expect(useTerminalTabs.getState().tabs).toHaveLength(1);
  });

  it("an attached tab knows its session from the start", () => {
    useTerminalTabs.getState().openAttachedTab({ sessionId: "sess-42", title: "Assistant terminal" });
    expect(useTerminalTabs.getState().tabs[0]!.sessionId).toBe("sess-42");
  });

  it("allowReseed does not invent a tab; it only permits the page to seed", () => {
    useTerminalTabs.getState().invalidateAll();
    useTerminalTabs.getState().allowReseed();
    expect(useTerminalTabs.getState().tabs).toHaveLength(0);
    expect(useTerminalTabs.getState().reseedAllowed).toBe(true);
  });
});
