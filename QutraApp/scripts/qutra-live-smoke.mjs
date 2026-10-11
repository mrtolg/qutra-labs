/**
 * Qutra live smoke — the packaged app, the real broker, the real lab.
 *
 * Everything else in this repo's assistant coverage stops at a boundary:
 * vitest mocks IPC, `cargo test` exercises broker policy without a model, and
 * Playwright runs the web build which has no broker at all. None of them can
 * answer the only question a user actually has — does it answer?
 *
 * This drives the built executable over CDP (same approach as
 * `packaged-smoke.mjs`) against whatever is really listening on 11435.
 *
 * Usage:
 *   CONTEXTOS_EXE=<path to contextos.exe> node scripts/qutra-live-smoke.mjs
 *
 * Requires the isolated lab to be running. It does not start it: the app must
 * never auto-start Ollama, and neither should its tests.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const executable = process.env.CONTEXTOS_EXE;
if (!executable) throw new Error("CONTEXTOS_EXE is required");

const LAB = "http://127.0.0.1:11435";
const port = 9338;

/** Fail early and clearly rather than blaming the app for a stopped lab. */
const tags = await fetch(`${LAB}/api/tags`).catch(() => null);
if (!tags?.ok) {
  console.error(
    `FAIL: no lab on ${LAB}. Start D:\\Local-AI-Lab\\start-isolated-ollama.ps1 first.`,
  );
  process.exit(2);
}
const installed = (await tags.json()).models.map((m) => m.name);
console.log(`lab is up with ${installed.length} model(s): ${installed.join(", ")}`);

const root = path.join(os.tmpdir(), `qutra-live-${process.pid}-${Date.now()}`);
await mkdir(root, { recursive: true });

const child = spawn(executable, [], {
  env: {
    ...process.env,
    /* NOTE — this does NOT isolate preferences, and an earlier version of this
       file claimed it did.

       Tauri resolves its app-data directory through the Windows known-folder
       API (SHGetKnownFolderPath), which ignores the APPDATA environment
       variable. So contextos.db is always the real one at
       %APPDATA%app.contextos.desktop, and anything this script changes in
       Settings changes it for real.

       WEBVIEW2_USER_DATA_FOLDER below *is* honoured, so browser-level state is
       isolated — but that is not where preferences live.

       Consequence: this script must only read. It must never flip a setting to
       make itself pass. */
    APPDATA: path.join(root, "appdata"),
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: "ignore",
  // The window must actually be shown. Hidden, WebView2 lays nothing out, so
  // every element reports a zero box and Playwright treats the whole UI as
  // invisible — clicks then time out for a reason that has nothing to do with
  // the app.
  windowsHide: false,
});

let browser;
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

try {
  // Give WebView2 a moment to open its debugging port.
  let page;
  for (let attempt = 0; attempt < 30 && !page; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = browser.contexts()[0]?.pages()[0];
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!page) throw new Error("could not attach to the app over CDP");

  await page.waitForTimeout(1500);

  const nav = async (hash) => {
    await page.evaluate((h) => {
      window.location.hash = h;
    }, hash);
    // Routes are lazy; wait for the skeleton to clear rather than guessing.
    await page.waitForFunction(
      () => !document.querySelector('[aria-busy="true"]'),
      { timeout: 20_000 },
    );
    await page.waitForTimeout(400);
  };
  console.log(`attached to: ${page.url()}`);
  await nav("#/settings?section=ai");

  const panel = page.getByTestId("local-assistant-settings");
  await panel.waitFor({ timeout: 20_000 });

  /* Read-only. These are the user's real preferences (see the note above), so
     this reports what it finds rather than switching the feature on to make
     itself pass. The aria-label sits on the wrapping <label>, so the input has
     no accessible name of its own; target it structurally. */
  const enable = panel.locator('input[type="checkbox"]').first();
  if (!(await enable.isChecked())) {
    console.error(
      "SKIP: Qutra is disabled in your real settings. Enable it in\n" +
        "Settings → AI providers and re-run — this script will not change it for you.",
    );
    process.exitCode = 3;
    throw new Error("assistant disabled");
  }
  check(true, "Qutra is enabled in the real profile");

  if (!(await page.getByTestId("local-assistant-settings").count())) {
    console.log("DIAG url:", page.url());
    console.log("DIAG body:", (await page.locator("body").innerText()).slice(0, 500));
    throw new Error("settings AI section did not render");
  }
  // By test id, not label: a fresh profile may be in any locale.
  await page.getByTestId("local-assistant-test-connection").click();

  const status = page.getByTestId("local-assistant-status");
  await status.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="local-assistant-status"]')
        ?.textContent !== "Not checked yet",
    { timeout: 20_000 },
  );
  const healthText = (await status.textContent())?.trim();
  const NOT_READY = ["Offline", "Model", "Error", "Desktop", "calismiyor", "bulunamadi", "Hata"];
  check(
    !!healthText && !NOT_READY.some((w) => healthText.includes(w)),
    `health is a ready state (got "${healthText}")`,
  );

  // The picker must list what the lab actually has — not a catalog.
  const picker = page.getByTestId("local-assistant-model-picker");
  if (await picker.count()) {
    const options = await picker.locator("option").allTextContents();
    check(
      options.some((o) => installed.some((m) => o.includes(m))),
      `model picker lists installed models (${options.length} shown)`,
    );
  }

  // The real question: does it stream an answer?
  await nav("#/jarvis");
  const composer = page.getByTestId("local-assistant-chat").locator('input:not([type="checkbox"])').first();
  await composer.fill("Reply with exactly: OK");
  await composer.press("Enter");

  const chat = page.getByTestId("local-assistant-chat");
  const before = Date.now();
  const baseline = ((await chat.textContent()) ?? "").length;
  let grew = false;
  try {
    await page.waitForFunction(
      (base) => {
        const el = document.querySelector('[data-testid="local-assistant-chat"]');
        return (el?.textContent?.length ?? 0) > base + 40;
      },
      baseline,
      { timeout: 180_000 },
    );
    grew = true;
  } catch {
    grew = false;
  }
  const elapsed = Date.now() - before;
  const body = (await chat.textContent()) ?? "";
  // The failure banner names the start script; its presence means no answer.
  const failed = body.includes("start-isolated-ollama.ps1");
  check(
    grew && !failed,
    failed
      ? `NO ANSWER — the app surfaced a failure after ${elapsed} ms ` +
        `(≈ the first-token timeout; a cold large model may simply need longer)`
      : `the model produced output (${elapsed} ms)`,
  );

  // Let it run a little, then Stop — cancellation is a broker path, not a UI one.
  await page.waitForTimeout(2000);


  const transcript = (await chat.textContent()) ?? "";
  check(transcript.includes("Reply with exactly"), "the question is kept in the transcript");
  check(
    !transcript.includes("start-isolated-ollama.ps1"),
    "an answer was rendered rather than a failure banner",
  );

  console.log("\n--- transcript tail ---");
  console.log(transcript.slice(-400));
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? "\nLIVE SMOKE: PASS" : `\nLIVE SMOKE: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
