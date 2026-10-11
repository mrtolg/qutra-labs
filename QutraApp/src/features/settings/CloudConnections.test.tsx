import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
import { CloudConnections } from "./CloudConnections";

/* Claude and OpenAI-compatible connections in Settings. Rust is
   mocked at `invoke`; keys are write-only, so no test ever reads one back. */

type Status = { present: boolean; last4: string | null; baseUrl: string | null };
const NONE: Status = { present: false, last4: null, baseUrl: null };

/** A fake Rust side: keys per account, a model list or an error per target. */
function rust(opts: {
  models?: Record<string, unknown>;
  failures?: Record<string, unknown>;
  setError?: string;
} = {}) {
  const keys = new Map<string, Status>();
  const name = (target: { provider: string; preset?: string }) =>
    target.provider === "anthropic" ? "anthropic" : `openai_compat:${target.preset}`;
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const target = args.target as { provider: string; preset?: string };
    const key = name(target);
    switch (command) {
      case "ai_key_has":
        return keys.get(key) ?? NONE;
      case "ai_key_set": {
        if (opts.setError) throw opts.setError;
        const value = String(args.key);
        keys.set(key, {
          present: true,
          last4: value ? value.slice(-4) : null,
          baseUrl: (args.baseUrl as string | null) ?? null,
        });
        return undefined;
      }
      case "ai_key_delete":
        keys.delete(key);
        return undefined;
      case "ai_list_models":
        if (opts.failures?.[key]) throw opts.failures[key];
        return opts.models?.[key] ?? [];
      default:
        throw new Error(`unexpected ${command}`);
    }
  });
  return keys;
}

const claude = () => screen.getByRole("region", { name: "Claude (Anthropic)" });
const compat = () => screen.getByRole("region", { name: "OpenAI-compatible" });

beforeEach(() => {
  invoke.mockReset();
  setDbForTesting(new Database(new MemoryStorageAdapter()));
  useUi.setState({ toasts: [] });
  setBridgeForTesting({ mode: "tauri" } as unknown as DesktopBridge);
});

afterEach(() => {
  resetBridgeForTesting();
  setDbForTesting(null);
});

describe("cloud connections", () => {
  it("saves a key it never shows again, only its last four characters", async () => {
    rust();
    render(<CloudConnections />);

    const card = await screen.findByRole("region", { name: "Claude (Anthropic)" });
    expect(await within(card).findByText("No key yet")).toBeInTheDocument();
    const field = within(card).getByLabelText("API key");
    await userEvent.type(field, "sk-ant-api03-example-WXYZ");
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));

    expect(invoke).toHaveBeenCalledWith("ai_key_set", {
      target: { provider: "anthropic" },
      key: "sk-ant-api03-example-WXYZ",
      baseUrl: null,
    });
    expect(await within(card).findByText("Key saved · ••••WXYZ")).toBeInTheDocument();
    expect(within(card).queryByDisplayValue(/example/)).not.toBeInTheDocument();
  });

  it("tests a connection and saves the model chosen from its list", async () => {
    const keys = rust({
      models: {
        anthropic: [
          { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
          { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
        ],
      },
    });
    keys.set("anthropic", { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" });
    render(<CloudConnections />);

    await userEvent.click(
      await within(claude()).findByRole("button", { name: "Test the connection" }),
    );

    expect(await within(claude()).findByText("Connected · 2 models")).toBeInTheDocument();
    const select = within(claude()).getByLabelText("Model");
    expect(select).toHaveValue("claude-opus-5-5");
    await userEvent.selectOptions(select, "claude-opus-4-8");
    expect(getDb().prefs.get().aiModels.anthropic).toBe("claude-opus-4-8");
  });

  it("says in plain words why a test failed", async () => {
    const keys = rust({
      failures: {
        anthropic: { code: "key_invalid" },
        "openai_compat:openai": { code: "rate_limited", retryAfterSeconds: 12 },
      },
    });
    keys.set("anthropic", { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" });
    keys.set("openai_compat:openai", { present: true, last4: "abcd", baseUrl: "https://api.openai.com/v1" });
    render(<CloudConnections />);

    await userEvent.click(
      await within(claude()).findByRole("button", { name: "Test the connection" }),
    );
    expect(await within(claude()).findByText(/The key was refused/)).toBeInTheDocument();

    await userEvent.click(
      await within(compat()).findByRole("button", { name: "Test the connection" }),
    );
    expect(await within(compat()).findByText(/Try again in 12 seconds/)).toBeInTheDocument();
  });

  it("asks for an address for a custom service and keeps it with the key", async () => {
    rust();
    render(<CloudConnections />);

    await userEvent.selectOptions(await within(compat()).findByLabelText("Service"), "custom");
    expect(getDb().prefs.get().aiOpenAiPreset).toBe("custom");
    const address = await within(compat()).findByLabelText("Address");
    await userEvent.type(address, "http://127.0.0.1:1234/v1");
    await userEvent.click(within(compat()).getByRole("button", { name: "Save" }));

    expect(invoke).toHaveBeenCalledWith("ai_key_set", {
      target: { provider: "openai_compat", preset: "custom" },
      key: "",
      baseUrl: "http://127.0.0.1:1234/v1",
    });
    expect(await within(compat()).findByText(/Saved without a key/)).toBeInTheDocument();
  });

  it("explains an address that is refused", async () => {
    rust({ setError: "invalid_base_url" });
    render(<CloudConnections />);

    await userEvent.selectOptions(await within(compat()).findByLabelText("Service"), "custom");
    await userEvent.type(await within(compat()).findByLabelText("Address"), "http://example.com/v1");
    await userEvent.type(within(compat()).getByLabelText("API key"), "sk-example-key-1234");
    await userEvent.click(within(compat()).getByRole("button", { name: "Save" }));

    expect(await within(compat()).findByRole("alert")).toHaveTextContent(
      /http:\/\/ only for a server on this computer/,
    );
  });

  it("removes a saved key", async () => {
    const keys = rust();
    keys.set("anthropic", { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" });
    render(<CloudConnections />);

    await userEvent.click(await within(claude()).findByRole("button", { name: "Remove key" }));
    // Nothing is removed before the user confirms.
    expect(invoke).not.toHaveBeenCalledWith("ai_key_delete", expect.anything());
    const dialog = await screen.findByRole("dialog", { name: "Remove the Claude (Anthropic) key?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));

    expect(invoke).toHaveBeenCalledWith("ai_key_delete", { target: { provider: "anthropic" } });
    expect(await within(claude()).findByText("No key yet")).toBeInTheDocument();
  });

  it("keeps the key when the removal is cancelled", async () => {
    const keys = rust();
    keys.set("anthropic", { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" });
    render(<CloudConnections />);

    await userEvent.click(await within(claude()).findByRole("button", { name: "Remove key" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove the Claude (Anthropic) key?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(invoke).not.toHaveBeenCalledWith("ai_key_delete", expect.anything());
    expect(within(claude()).getByText("Key saved · ••••WXYZ")).toBeInTheDocument();
  });

  it("keeps each service's model its own when the service changes after a test", async () => {
    const keys = rust({
      models: { "openai_compat:openai": [{ id: "gpt-a", name: "gpt-a" }] },
    });
    keys.set("openai_compat:openai", { present: true, last4: "abcd", baseUrl: "https://api.openai.com/v1" });
    render(<CloudConnections />);

    await userEvent.click(await within(compat()).findByRole("button", { name: "Test the connection" }));
    expect(await within(compat()).findByText("Connected · 1 models")).toBeInTheDocument();
    await userEvent.selectOptions(within(compat()).getByLabelText("Service"), "gemini");

    expect(await within(compat()).findByText("No key yet")).toBeInTheDocument();
    expect(within(compat()).queryByLabelText("Model")).not.toBeInTheDocument();
    expect(getDb().prefs.get().aiModels["openai_compat:gemini"]).toBeUndefined();
  });

  it("saves no model until the user picks one", async () => {
    const keys = rust({
      models: { "openai_compat:openai": [{ id: "text-embedding-3", name: "text-embedding-3" }, { id: "gpt-a", name: "gpt-a" }] },
    });
    keys.set("openai_compat:openai", { present: true, last4: "abcd", baseUrl: "https://api.openai.com/v1" });
    render(<CloudConnections />);

    await userEvent.click(await within(compat()).findByRole("button", { name: "Test the connection" }));
    const select = await within(compat()).findByLabelText("Model");
    expect(within(select).getByRole("option", { name: "Choose a model" })).toBeInTheDocument();
    expect(getDb().prefs.get().aiModels["openai_compat:openai"]).toBeUndefined();

    await userEvent.selectOptions(select, "gpt-a");
    expect(getDb().prefs.get().aiModels["openai_compat:openai"]).toBe("gpt-a");
  });

  it("puts the keyboard in the key field when a key is changed", async () => {
    const keys = rust();
    keys.set("anthropic", { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" });
    render(<CloudConnections />);

    await userEvent.click(await within(claude()).findByRole("button", { name: "Change" }));

    await waitFor(() => expect(within(claude()).getByLabelText("API key")).toHaveFocus());
  });

  it("says when a key could not be removed", async () => {
    const keys = rust();
    keys.set("anthropic", { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" });
    render(<CloudConnections />);
    await within(claude()).findByRole("button", { name: "Remove key" });
    invoke.mockImplementationOnce(async () => {
      throw "platform_failure";
    });

    await userEvent.click(within(claude()).getByRole("button", { name: "Remove key" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));

    await waitFor(() =>
      expect(useUi.getState().toasts.map((toast) => toast.messageKey)).toContain(
        "settings.cloud.error.removeFailed",
      ),
    );
  });

  it("says how to fix an address nothing answers at", async () => {
    const keys = rust({ failures: { "openai_compat:custom": { code: "address_not_found" } } });
    keys.set("openai_compat:custom", { present: true, last4: null, baseUrl: "http://127.0.0.1:11434" });
    getDb().prefs.set({ aiOpenAiPreset: "custom" });
    render(<CloudConnections />);

    await userEvent.click(await within(compat()).findByRole("button", { name: "Test the connection" }));

    expect(await within(compat()).findByRole("alert")).toHaveTextContent(/usually ends in \/v1/);
  });

  it("says cloud connections need the desktop app in the browser build", () => {
    setBridgeForTesting({ mode: "browser" } as unknown as DesktopBridge);
    render(<CloudConnections />);

    expect(screen.getByText("Cloud connections work in the desktop app.")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses a connection for Jarvis from its own card", async () => {
    const keys = rust();
    keys.set("anthropic", { present: true, last4: "WXYZ", baseUrl: "https://api.anthropic.com" });
    render(<CloudConnections />);

    await userEvent.click(await within(claude()).findByRole("button", { name: "Use for Jarvis" }));

    expect(getDb().prefs.get().aiProvider).toBe("anthropic");
    expect(within(claude()).getByText("Jarvis uses this")).toBeInTheDocument();
    expect(within(claude()).queryByRole("button", { name: "Use for Jarvis" })).not.toBeInTheDocument();
  });
});
