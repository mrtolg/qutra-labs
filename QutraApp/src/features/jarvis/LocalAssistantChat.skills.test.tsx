import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invoke = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => [] as Array<(event: { payload: unknown }) => void>);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.push(handler);
    return () => {
      handlers.splice(handlers.indexOf(handler), 1);
    };
  }),
}));
vi.mock("@/lib/localAssistant/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/localAssistant/client")>();
  return {
    ...actual,
    localAssistant: {
      available: vi.fn().mockReturnValue(true),
      checkHealth: vi.fn().mockResolvedValue({ status: "ready", models: [] }),
      listModels: vi.fn().mockResolvedValue({ status: "unavailable", models: [] }),
      streamChat: vi.fn().mockResolvedValue("Tamam."),
      approveTool: vi.fn().mockResolvedValue({ resolved: true }),
    },
  };
});

import { Database, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { resetBridgeForTesting, setBridgeForTesting, type DesktopBridge } from "@/lib/bridge";
import { localAssistant } from "@/lib/localAssistant/client";
import { useUi } from "@/state/ui";
import { LocalAssistantChat } from "./LocalAssistantChat";


/* The skills picked in the composer, local and cloud.
   Rust is mocked at `invoke`; nothing leaves the test. */

Element.prototype.scrollTo = vi.fn();

type Started = { requestId: string; model: string; messages: { role: string; content: string }[] };
const KEY = { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" };

function rust() {
  const started: Started[] = [];
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "ai_key_has") return KEY;
    if (command === "ai_chat_start") {
      started.push(args.request as Started);
      return { accepted: true };
    }
    if (command === "ai_chat_cancel") return undefined;
    throw new Error(`unexpected ${command}`);
  });
  return started;
}

async function finish(started: Started[], text = "Tamam.") {
  const turn = started.at(-1)!;
  const requestId = turn.requestId;
  // Rust sends back the last question as it went out (here nothing to mask).
  const sentText = turn.messages.at(-1)!.content;
  await act(async () => {
    for (const handler of [...handlers]) {
      handler({
        payload: { requestId, kind: "bound", endpoint: "api.anthropic.com", model: "claude-opus-5-5", sentBytes: 900, sentText },
      });
      handler({
        payload: {
          requestId,
          kind: "done",
          result: { text, blocks: null, stop: "end_turn", refusalCategory: null, servedBy: "claude-opus-5-5", fallbackFrom: null, usage: null },
        },
      });
    }
  });
}

async function ask(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Message to Qutra"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

function seed(prefs: Record<string, unknown>) {
  const db = new Database(new MemoryStorageAdapter());
  db.prefs.set({ assistantContextEnabled: false, ...prefs });
  setDbForTesting(db);
  return db;
}

beforeEach(() => {
  invoke.mockReset();
  handlers.length = 0;
  useUi.setState({ settingsSection: null });
  setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
});

afterEach(() => {
  setDbForTesting(null);
  resetBridgeForTesting();
  vi.clearAllMocks();
});

async function pick(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByText("Skills"));
  await user.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
}

describe("skills in the composer", () => {
  it("go to the cloud with the next question only, and say so under it", async () => {
    seed({ aiProvider: "anthropic", localAssistantEnabled: false });
    const started = rust();
    render(<LocalAssistantChat />);

    await pick("Extract IOCs");
    expect(screen.getByTestId("skill-chip")).toHaveTextContent("Skill: Extract IOCs");

    await ask("hxxp://evil.example 10.0.0.9");
    await waitFor(() => expect(started).toHaveLength(1));
    const first = started[0]!.messages.at(-1)!.content;
    expect(first).toContain("Skill: ioc");
    expect(first).toContain("indicators of compromise");
    expect(first.endsWith("hxxp://evil.example 10.0.0.9")).toBe(true);
    // Spent on that question: the chip is gone.
    expect(screen.queryByTestId("skill-chip")).not.toBeInTheDocument();
    await finish(started);
    expect(await screen.findByText(/Sent with a skill’s instructions/)).toBeInTheDocument();

    await ask("And another");
    await waitFor(() => expect(started).toHaveLength(2));
    expect(started[1]!.messages.at(-1)!.content).toBe("And another");
  });

  it("ride as the system message of a local turn, once", async () => {
    seed({ aiProvider: "ollama", localAssistantEnabled: true });
    render(<LocalAssistantChat />);
    await pick("Explain a command");
    await ask("rm -rf ./build");
    const streamChat = vi.mocked(localAssistant.streamChat);
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
    const [, messages] = streamChat.mock.calls[0]!;
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]!.content).toContain("Skill: command");
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "rm -rf ./build" });

    await ask("next");
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2));
    const [, second] = streamChat.mock.calls[1]!;
    expect(second.some((m) => m.content.includes("Skill: command") && m.role === "system")).toBe(false);
  });

  it("can be taken off before sending", async () => {
    seed({ aiProvider: "anthropic", localAssistantEnabled: false });
    const started = rust();
    render(<LocalAssistantChat />);
    await pick("Write a finding");
    await userEvent.click(screen.getByRole("button", { name: "Remove skill Write a finding" }));
    expect(screen.queryByTestId("skill-chip")).not.toBeInTheDocument();
    await ask("Plain");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.messages.at(-1)!.content).toBe("Plain");
  });
});
