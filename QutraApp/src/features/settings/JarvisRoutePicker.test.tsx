import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  resetBridgeForTesting,
  setBridgeForTesting,
  type DesktopBridge,
} from "@/lib/bridge";
import { useUi } from "@/state/ui";
import { JarvisRoutePicker } from "./JarvisRoutePicker";
import { CloudConnections } from "./CloudConnections";

type Status = { present: boolean; last4: string | null; baseUrl: string | null };
const NONE: Status = { present: false, last4: null, baseUrl: null };

function rust(keys: Record<string, Status>) {
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const target = args.target as { provider: string; preset?: string };
    const name =
      target.provider === "anthropic" ? "anthropic" : `openai_compat:${target.preset}`;
    if (command === "ai_key_has") return keys[name] ?? NONE;
    if (command === "ai_key_delete") {
      delete keys[name];
      return undefined;
    }
    throw new Error(`unexpected ${command}`);
  });
}

const tile = (name: RegExp) => screen.getByRole("radio", { name });

beforeEach(() => {
  invoke.mockReset();
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  useUi.setState({ toasts: [], liveMessage: "" });
  setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
});

afterEach(() => {
  resetBridgeForTesting();
  setDbForTesting(null);
});

describe("Jarvis route picker", () => {
  it("offers the local model and each cloud connection, saying where a question goes", async () => {
    rust({ anthropic: { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" } });
    render(<JarvisRoutePicker />);

    expect(
      screen.getByRole("radiogroup", { name: "Which way does Jarvis talk?" }),
    ).toBeInTheDocument();
    expect(tile(/Local model/)).toBeChecked();
    expect(await screen.findByText("Key saved · ••••WXYZ")).toBeInTheDocument();
    expect(screen.getByText("→ api.anthropic.com")).toBeInTheDocument();
  });

  it("switches Jarvis to a connection with a key, with a toast and an announcement", async () => {
    rust({ anthropic: { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" } });
    render(<JarvisRoutePicker />);
    await screen.findByText("Key saved · ••••WXYZ");

    await userEvent.click(tile(/Claude \(Anthropic\)/));

    expect(getDb().prefs.get().aiProvider).toBe("anthropic");
    expect(tile(/Claude \(Anthropic\)/)).toBeChecked();
    expect(useUi.getState().toasts.at(-1)?.message).toBe(
      "Jarvis now talks through Claude (Anthropic)",
    );
    expect(useUi.getState().liveMessage).toBe("Jarvis now talks through Claude (Anthropic)");
  });

  it("cannot pick a cloud connection that has no key", async () => {
    rust({});
    render(<JarvisRoutePicker />);
    const claude = tile(/Claude \(Anthropic\)/);
    await within(claude.closest("label")!).findByText("Add a key first");

    expect(claude).toBeDisabled();
    expect(getDb().prefs.get().aiProvider).toBe("ollama");
  });

  it("warns when the chosen route cannot answer", async () => {
    rust({});
    getDb().prefs.set({ aiProvider: "anthropic" });
    render(<JarvisRoutePicker />);

    expect(
      await screen.findByText(/There is no saved key for Claude \(Anthropic\), so Jarvis cannot answer/),
    ).toBeInTheDocument();
  });

  it("updates at once when a card removes the key in use", async () => {
    const keys = { anthropic: { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" } };
    rust(keys);
    getDb().prefs.set({ aiProvider: "anthropic" });
    render(
      <>
        <JarvisRoutePicker />
        <CloudConnections />
      </>,
    );
    const card = await screen.findByRole("region", { name: "Claude (Anthropic)" });
    await userEvent.click(await within(card).findByRole("button", { name: "Remove key" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Jarvis uses this connection right now");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));

    expect(
      await screen.findByText(/There is no saved key for Claude \(Anthropic\)/),
    ).toBeInTheDocument();
  });

  it("says cloud routes need the desktop app in the browser build", () => {
    setBridgeForTesting({ mode: "browser" } as unknown as DesktopBridge);
    render(<JarvisRoutePicker />);

    expect(screen.getAllByText("Only in the desktop app")).toHaveLength(2);
    expect(invoke).not.toHaveBeenCalled();
  });
});
