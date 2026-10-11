import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserTerminal,
  type TerminalController,
  type TerminalSessionEvent,
  type TerminalSessionInfo,
  type TerminalSessionList,
} from "@/lib/bridge/terminal";
import {
  ENDED_SESSIONS_KEPT,
  applyEvent,
  applyList,
  connectTerminalSessionFacts,
  emptyFacts,
  liveSessions,
  useTerminalSessionFacts,
} from "./terminalSessionFacts";

// Shaped like production: UUID runtime and session ids, a Windows profile
// path, a real PID -- not hand-written "s1" ids.
const RUNTIME = "0b3f6d2a-9c41-4e7b-8f15-6a2d9e0c7b84";
const OTHER_RUNTIME = "e71c0a95-34bd-4f28-a6c9-1d5e8b2f7a03";

function session(
  sessionId: string,
  revision: number,
  patch: Partial<TerminalSessionInfo> = {},
): TerminalSessionInfo {
  return {
    runtimeId: RUNTIME,
    sessionId,
    revision,
    origin: "user",
    installationId: null,
    state: "running",
    ioState: "open",
    pid: 21_904,
    programName: "pwsh.exe",
    startedAt: 1_727_800_000_000,
    elapsedMs: 1_200,
    initialCwd: "C:\\Users\\Analyst",
    cwdSource: "spawn",
    exit: null,
    ...patch,
  };
}

const event = (s: TerminalSessionInfo, runtimeId = RUNTIME): TerminalSessionEvent => ({
  runtimeId,
  revision: s.revision,
  session: { ...s, runtimeId },
});

const ID_A = "5c2e8f14-7a0b-4d93-b6e1-0f9a3c7d2e58";
const ID_B = "a94d1b07-2e6f-4c85-9d3a-7b0e5f1c8a26";

function fakeController() {
  let listener: ((e: TerminalSessionEvent) => void) | null = null;
  const lists: Array<(l: TerminalSessionList) => void> = [];
  const off = vi.fn();
  const controller = {
    ...createBrowserTerminal(),
    available: () => true,
    onSession: vi.fn(async (l: (e: TerminalSessionEvent) => void) => {
      listener = l;
      return off;
    }),
    listSessions: vi.fn(
      () => new Promise<TerminalSessionList>((resolve) => lists.push(resolve)),
    ),
  } satisfies TerminalController;
  return {
    controller,
    off,
    emit: (e: TerminalSessionEvent) => listener?.(e),
    resolveList: (l: TerminalSessionList) => lists.shift()?.(l),
    listCalls: () => controller.listSessions.mock.calls.length,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => useTerminalSessionFacts.setState(emptyFacts, true));

describe("terminal session facts", () => {
  it("a list is the whole truth as of its revision", () => {
    const facts = applyList({ runtimeId: RUNTIME, revision: 4, sessions: [session(ID_A, 4)] });
    expect(facts.runtimeId).toBe(RUNTIME);
    expect(facts.revision).toBe(4);
    expect(Object.keys(facts.byId)).toEqual([ID_A]);
    expect(facts.status).toBe("live");
  });

  it("counts only sessions that have not ended as live", () => {
    const facts = applyList({
      runtimeId: RUNTIME,
      revision: 3,
      sessions: [
        session(ID_A, 3),
        session(ID_B, 2, { state: "exited", exit: { code: 0, reason: "natural", endedAt: 1 } }),
      ],
    });
    expect(liveSessions(facts).map((s) => s.sessionId)).toEqual([ID_A]);
    expect(liveSessions(emptyFacts)).toEqual([]);
  });

  it("ignores an event the snapshot already covers", () => {
    const facts = applyList({
      runtimeId: RUNTIME,
      revision: 6,
      sessions: [session(ID_A, 6, { state: "stopping" })],
    });
    const stale = event(session(ID_A, 5, { state: "running" }));
    expect(applyEvent(facts, stale)).toBe(facts);
  });

  it("applies a newer event, including one for a session Rust no longer lists", () => {
    const facts = applyList({ runtimeId: RUNTIME, revision: 6, sessions: [] });
    const exited = session(ID_A, 7, {
      state: "exited",
      exit: { code: 0, reason: "stopped", endedAt: 1_727_800_004_000 },
    });
    const next = applyEvent(facts, event(exited));
    expect(next).not.toBe("resync");
    if (next === "resync") return;
    expect(next.revision).toBe(7);
    expect(next.byId[ID_A]?.exit?.reason).toBe("stopped");
  });

  it("asks for a resync when an event comes from another native runtime", () => {
    const facts = applyList({ runtimeId: RUNTIME, revision: 2, sessions: [] });
    expect(applyEvent(facts, event(session(ID_A, 3), OTHER_RUNTIME))).toBe("resync");
  });

  it("keeps a bounded number of ended sessions and never drops a running one", () => {
    let facts = applyList({ runtimeId: RUNTIME, revision: 1, sessions: [session(ID_B, 1)] });
    for (let i = 0; i < ENDED_SESSIONS_KEPT + 5; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const next = applyEvent(
        facts,
        event(
          session(id, i + 2, {
            state: "exited",
            exit: { code: 1, reason: "natural", endedAt: 1 },
          }),
        ),
      );
      if (next === "resync") throw new Error("unexpected resync");
      facts = next;
    }
    const ended = Object.values(facts.byId).filter((s) => s.state === "exited");
    expect(ended).toHaveLength(ENDED_SESSIONS_KEPT);
    expect(facts.byId[ID_B]?.state).toBe("running");
    // The oldest ended sessions went first.
    expect(facts.byId["00000000-0000-4000-8000-000000000000"]).toBeUndefined();
  });

  it("subscribes before listing and replays only events newer than the list", async () => {
    const fake = fakeController();
    const connecting = connectTerminalSessionFacts(fake.controller);
    await flush();
    expect(fake.controller.onSession).toHaveBeenCalled();
    expect(fake.listCalls()).toBe(1);

    // Both arrive while the list is in flight: one the list will cover,
    // one it will not.
    fake.emit(event(session(ID_A, 3)));
    fake.emit(event(session(ID_A, 5, { state: "stopping" })));
    fake.resolveList({ runtimeId: RUNTIME, revision: 4, sessions: [session(ID_A, 4)] });
    await connecting;

    const facts = useTerminalSessionFacts.getState();
    expect(facts.revision).toBe(5);
    expect(facts.byId[ID_A]?.state).toBe("stopping");

    fake.emit(event(session(ID_B, 6, { origin: "assistant" })));
    expect(useTerminalSessionFacts.getState().byId[ID_B]?.origin).toBe("assistant");
  });

  it("re-lists when the native runtime changes underneath it", async () => {
    const fake = fakeController();
    const connecting = connectTerminalSessionFacts(fake.controller);
    await flush();
    fake.resolveList({ runtimeId: RUNTIME, revision: 2, sessions: [session(ID_A, 2)] });
    await connecting;

    fake.emit(event(session(ID_B, 1), OTHER_RUNTIME));
    await flush();
    expect(fake.listCalls()).toBe(2);
    fake.resolveList({
      runtimeId: OTHER_RUNTIME,
      revision: 1,
      sessions: [{ ...session(ID_B, 1), runtimeId: OTHER_RUNTIME }],
    });
    await flush();

    const facts = useTerminalSessionFacts.getState();
    expect(facts.runtimeId).toBe(OTHER_RUNTIME);
    expect(Object.keys(facts.byId)).toEqual([ID_B]);
  });

  it("a foreign runtime takes live authority away at once, before any list", async () => {
    const fake = fakeController();
    const connecting = connectTerminalSessionFacts(fake.controller);
    await flush();
    fake.resolveList({ runtimeId: RUNTIME, revision: 2, sessions: [session(ID_A, 2)] });
    await connecting;
    expect(liveSessions(useTerminalSessionFacts.getState()).map((s) => s.sessionId)).toEqual([ID_A]);

    // Rust restarted: the list it is asked for never completes here.
    fake.emit(event(session(ID_B, 1), OTHER_RUNTIME));
    const facts = useTerminalSessionFacts.getState();
    expect(facts.status).toBe("reconciling");
    expect(liveSessions(facts)).toEqual([]);
    // The old session stays as history, not as a running process.
    expect(facts.byId[ID_A]).toBeDefined();
  });

  it("a failed list marks the facts unavailable and retries without waiting for an event", async () => {
    const fake = fakeController();
    const connecting = connectTerminalSessionFacts(fake.controller, { retryDelaysMs: [5] });
    await flush();
    fake.resolveList({ runtimeId: RUNTIME, revision: 2, sessions: [session(ID_A, 2)] });
    await connecting;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fake.controller.listSessions.mockRejectedValueOnce(new Error("ipc timeout"));
    fake.emit(event(session(ID_B, 1), OTHER_RUNTIME));
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(useTerminalSessionFacts.getState().status).toBe("unavailable");
    expect(liveSessions(useTerminalSessionFacts.getState())).toEqual([]);

    // No further session event: the retry alone asks again.
    await vi.waitFor(() => expect(fake.listCalls()).toBe(3));
    fake.resolveList({
      runtimeId: OTHER_RUNTIME,
      revision: 2,
      sessions: [{ ...session(ID_B, 2), runtimeId: OTHER_RUNTIME }],
    });
    await vi.waitFor(() => expect(useTerminalSessionFacts.getState().status).toBe("live"));
    expect(useTerminalSessionFacts.getState().runtimeId).toBe(OTHER_RUNTIME);
    expect(liveSessions(useTerminalSessionFacts.getState()).map((s) => s.sessionId)).toEqual([ID_B]);
  });

  it("an aborted connector publishes nothing, even when its list lands after a newer one", async () => {
    const older = fakeController();
    const first = new AbortController();
    const olderConnecting = connectTerminalSessionFacts(older.controller, { signal: first.signal });
    await flush();
    // Unmounted while its list is still in flight, then mounted again.
    first.abort();
    expect(older.off).toHaveBeenCalledTimes(1);

    const newer = fakeController();
    const newerConnecting = connectTerminalSessionFacts(newer.controller);
    await flush();
    newer.resolveList({ runtimeId: OTHER_RUNTIME, revision: 9, sessions: [] });
    await newerConnecting;

    older.resolveList({ runtimeId: RUNTIME, revision: 3, sessions: [session(ID_A, 3)] });
    await olderConnecting;
    older.emit(event(session(ID_A, 4)));

    const facts = useTerminalSessionFacts.getState();
    expect(facts.runtimeId).toBe(OTHER_RUNTIME);
    expect(facts.byId[ID_A]).toBeUndefined();
  });

  it("stops listening when disposed; a failed first list retries instead of giving up", async () => {
    const fake = fakeController();
    const connecting = connectTerminalSessionFacts(fake.controller);
    await flush();
    fake.resolveList({ runtimeId: RUNTIME, revision: 0, sessions: [] });
    const dispose = await connecting;
    dispose();
    expect(fake.off).toHaveBeenCalledTimes(1);
    fake.emit(event(session(ID_A, 1)));
    expect(useTerminalSessionFacts.getState().byId[ID_A]).toBeUndefined();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = fakeController();
    failing.controller.listSessions.mockRejectedValueOnce(new Error("ipc timeout"));
    const stop = await connectTerminalSessionFacts(failing.controller, { retryDelaysMs: [5] });
    warn.mockRestore();
    expect(useTerminalSessionFacts.getState().status).toBe("unavailable");
    expect(failing.off).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(failing.listCalls()).toBe(2));
    failing.resolveList({ runtimeId: RUNTIME, revision: 1, sessions: [session(ID_A, 1)] });
    await vi.waitFor(() => expect(useTerminalSessionFacts.getState().status).toBe("live"));
    stop();
    expect(failing.off).toHaveBeenCalledTimes(1);
  });

  it("in the browser there are no sessions, and none are invented", async () => {
    const dispose = await connectTerminalSessionFacts(createBrowserTerminal());
    expect(useTerminalSessionFacts.getState()).toEqual({
      runtimeId: "browser",
      revision: 0,
      byId: {},
      status: "live",
    });
    dispose();
  });
});
