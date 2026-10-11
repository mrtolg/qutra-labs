import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const openerOpenUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openerOpenUrl }));

import { TauriBridge } from "./tauriBridge";

afterEach(() => {
  invoke.mockReset();
  listen.mockReset();
  openerOpenUrl.mockReset();
});

describe("TauriBridge opens addresses and paths through Rust only", () => {
  it("opens a URL through the checked command and never through the opener plugin", async () => {
    invoke.mockResolvedValue(undefined);
    openerOpenUrl.mockResolvedValue(undefined);

    await expect(new TauriBridge().openUrl("https://example.com")).resolves.toEqual({
      ok: true,
      simulated: false,
    });

    expect(invoke).toHaveBeenCalledWith("open_url_checked", { url: "https://example.com" });
    expect(openerOpenUrl).not.toHaveBeenCalled();
  });

  it("reports a refusal from Rust as not opened, with no second route", async () => {
    invoke.mockRejectedValue("invalid_scheme");
    openerOpenUrl.mockResolvedValue(undefined);

    await expect(new TauriBridge().openUrl("file:///C:/Windows/notepad.exe")).resolves.toEqual({
      ok: false,
      simulated: false,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(openerOpenUrl).not.toHaveBeenCalled();
  });

  it("opens a path through the checked command, and says so when Rust refuses", async () => {
    invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce("not_openable");

    const bridge = new TauriBridge();
    await expect(bridge.openPath("C:\\cases\\one")).resolves.toEqual({ ok: true, simulated: false });
    await expect(bridge.openPath("C:\\cases\\tool.exe")).resolves.toEqual({
      ok: false,
      simulated: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "open_path_checked", { path: "C:\\cases\\tool.exe" });
  });
});

/* The window's capability file grants no opener or SQL permission (see the
   Rust test `the_window_holds_no_opener_or_sql_permission`); the page must not
   import either plugin, or it would fail at run time. */
describe("the page does not import the opener or SQL plugins", () => {
  const FORBIDDEN = ["@tauri-apps/plugin-opener", "@tauri-apps/plugin-sql"];

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it("has no such import in the application sources", () => {
    const offenders = sources(join(process.cwd(), "src")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return FORBIDDEN.some((name) => text.includes(`"${name}"`));
    });
    expect(offenders).toEqual([]);
  });
});
