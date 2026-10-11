import { describe, expect, it, vi } from "vitest";
import { wireFromId } from "./useTerminalSession";
import type { TerminalController } from "@/lib/bridge/terminal";

interface FakeController extends TerminalController {
  emit: (id: string, seq: number, data: string) => void;
  /** Resolve the pending `scrollback()` call `wireFromId` is awaiting. Tests
   * that need to interleave a live `emit` with the handover call this
   * *after* emitting; tests that don't care about the handover window can
   * call it immediately, before `wireFromId` even runs. */
  resolveScrollback: (text: string, cursor: number) => void;
}

function fakeController(): FakeController {
  let cb: (e: { id: string; data: string; seq: number }) => void = () => {};
  let resolve: (v: { text: string; cursor: number }) => void = () => {};
  const scrollbackPromise = new Promise<{ text: string; cursor: number }>((res) => {
    resolve = res;
  });
  return {
    available: () => true,
    resolvedShell: vi.fn().mockResolvedValue({ program: "pwsh.exe", kind: "pwsh" }),
    open: vi.fn().mockResolvedValue("sess-1"),
    openTool: vi.fn().mockResolvedValue("sess-1"),
    write: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue({ requested: 0, failed: [] }),
    onData: vi.fn().mockImplementation((l) => { cb = l; return Promise.resolve(() => {}); }),
    scrollback: vi.fn().mockImplementation(() => scrollbackPromise),
    listSessions: vi.fn().mockResolvedValue({ runtimeId: "browser", revision: 0, sessions: [] }),
    onSession: vi.fn().mockResolvedValue(() => {}),
    emit: (id, seq, data) => cb({ id, data, seq }),
    resolveScrollback: (text, cursor) => resolve({ text, cursor }),
  };
}

function fakeXterm(writes: string[]) {
  const xterm = {
    write: (s: string) => writes.push(s),
    onData: (h: (d: string) => void) => {
      xterm._input = h;
    },
    _input: (_d: string) => {},
  };
  return xterm as unknown as { write: (s: string) => void; onData: (h: (d: string) => void) => void; _input: (d: string) => void };
}

describe("wireFromId", () => {
  it("routes bytes by session id, forwards keystrokes, and disposes", async () => {
    const controller = fakeController();
    controller.resolveScrollback("", 0);
    const writes: string[] = [];
    const xterm = fakeXterm(writes);

    // Open a fake session id inline — wireFromId only wires an id that's
    // already open, it never opens one itself.
    const session = await wireFromId(controller, xterm, "sess-1");

    controller.emit("sess-1", 5, "hello");
    controller.emit("other", 5, "IGNORED");
    expect(writes).toEqual(["hello"]);

    xterm._input("ls\r");
    expect(controller.write).toHaveBeenCalledWith("sess-1", "ls\r");

    await session.dispose();
    expect(controller.close).toHaveBeenCalledWith("sess-1");
  });

  it("replays the scrollback snapshot, in order, before any live byte still buffered from the handover", async () => {
    const controller = fakeController();
    const writes: string[] = [];
    const xterm = fakeXterm(writes);

    // wireFromId subscribes to live data before it fetches the snapshot
    // (see its doc comment) -- this is the race window under test: a live
    // byte can arrive while the snapshot fetch is still in flight.
    const sessionPromise = wireFromId(controller, xterm, "sess-1");
    controller.emit("sess-1", 8, "LIVE");
    controller.resolveScrollback("BACKLOG", 5);
    await sessionPromise;

    expect(writes).toEqual(["BACKLOG", "LIVE"]);
  });

  it("drops a buffered live event the snapshot already covers, and keeps one that arrived after it — no gap, no duplicate", async () => {
    const controller = fakeController();
    const writes: string[] = [];
    const xterm = fakeXterm(writes);

    const sessionPromise = wireFromId(controller, xterm, "sess-1");
    // "AAAAA" is 5 bytes; the snapshot below reports cursor 5, meaning this
    // exact chunk is already inside `text` -- replaying it too would
    // duplicate it.
    controller.emit("sess-1", 5, "AAAAA");
    // seq 8 > cursor 5: produced after the snapshot was taken, so it must
    // be replayed or it is lost -- a gap.
    controller.emit("sess-1", 8, "BBB");
    controller.resolveScrollback("AAAAA", 5);
    await sessionPromise;

    expect(writes).toEqual(["AAAAA", "BBB"]);
  });

  it("writes live events directly, with no further buffering, once the handover has completed", async () => {
    const controller = fakeController();
    controller.resolveScrollback("", 0);
    const writes: string[] = [];
    const xterm = fakeXterm(writes);

    await wireFromId(controller, xterm, "sess-1");
    controller.emit("sess-1", 4, "first");
    controller.emit("sess-1", 9, "second");

    expect(writes).toEqual(["first", "second"]);
  });

  it("unsubscribes and throws session_gone when scrollback says the session is missing", async () => {
    const off = vi.fn();
    const writes: string[] = [];
    const xterm = fakeXterm(writes);
    const controller = fakeController();
    controller.onData = vi.fn().mockResolvedValue(off);
    controller.scrollback = vi.fn().mockRejectedValue("no such session");

    await expect(wireFromId(controller, xterm, "dead-sess")).rejects.toBe(
      "session_gone",
    );
    expect(off).toHaveBeenCalledTimes(1);
    expect(controller.close).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("throws scrollback_failed when the session exists but the read fails", async () => {
    const off = vi.fn();
    const writes: string[] = [];
    const xterm = fakeXterm(writes);
    const controller = fakeController();
    controller.onData = vi.fn().mockResolvedValue(off);
    controller.scrollback = vi.fn().mockRejectedValue("ipc timeout");

    await expect(wireFromId(controller, xterm, "sess-1")).rejects.toBe(
      "scrollback_failed",
    );
    expect(off).toHaveBeenCalledTimes(1);
    expect(controller.close).not.toHaveBeenCalled();
  });

  it("treats unknown_session as confirmed absence", async () => {
    const off = vi.fn();
    const xterm = fakeXterm([]);
    const controller = fakeController();
    controller.onData = vi.fn().mockResolvedValue(off);
    controller.scrollback = vi.fn().mockRejectedValue("unknown_session");

    await expect(wireFromId(controller, xterm, "dead-sess")).rejects.toBe(
      "session_gone",
    );
  });
});
