/**
 * Packaged native smoke: register a fixture exe, run it via the supervisor,
 * verify a real PID + succeeded state, then relaunch and confirm persistence.
 *
 *   CONTEXTOS_EXE=...\contextos.exe `
 *   CONTEXTOS_FIXTURE_EXE=...\fixture.exe `
 *   node scripts/packaged-native-smoke.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const executable = process.env.CONTEXTOS_EXE;
const fixture = process.env.CONTEXTOS_FIXTURE_EXE;
if (!executable) throw new Error("CONTEXTOS_EXE is required");
if (!fixture) throw new Error("CONTEXTOS_FIXTURE_EXE is required");

const port = 9338;
const smokeRoot = path.join(
  os.tmpdir(),
  `contextos-packaged-native-${process.pid}-${Date.now()}`,
);
const appdata = path.join(smokeRoot, "appdata");
await mkdir(smokeRoot, { recursive: true });

async function launch() {
  const child = spawn(executable, [], {
    env: {
      ...process.env,
      APPDATA: appdata,
      WEBVIEW2_USER_DATA_FOLDER: path.join(smokeRoot, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // WebView2 still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    if (child.pid) child.kill();
    throw new Error("Packaged WebView CDP endpoint did not start");
  }
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page =
    context.pages().find((candidate) => candidate.url() !== "about:blank") ??
    context.pages()[0];
  if (!page) throw new Error("Packaged WebView page was not exposed");
  await page.waitForLoadState("domcontentloaded");
  return { child, browser, page };
}

async function invoke(page, cmd, args = {}) {
  return page.evaluate(
    async ({ cmd, args }) => {
      const api = window.__TAURI_INTERNALS__;
      if (!api?.invoke) throw new Error("native invoke missing");
      return api.invoke(cmd, args);
    },
    { cmd, args },
  );
}

async function skipOnboarding(page) {
  const skip = page.getByRole("button", {
    name: /Skip setup|Kurulumu atla/i,
  });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page
    .locator(".ctx-sidebar-nav")
    .waitFor({ state: "visible", timeout: 20_000 });
}

async function stopSession(browser, child) {
  await browser?.close().catch(() => {});
  if (child?.pid && child.exitCode === null) child.kill();
  await new Promise((resolve) => setTimeout(resolve, 750));
}

let browser;
let child;
try {
  const first = await launch();
  child = first.child;
  browser = first.browser;
  const page = first.page;
  await skipOnboarding(page);

  const bridgeKind = await page.evaluate(() =>
    window.__TAURI_INTERNALS__?.invoke ? "native" : "browser",
  );
  if (bridgeKind !== "native") {
    throw new Error("Packaged app is not in native bridge mode");
  }

  await invoke(page, "inspect_tool_candidate", { path: fixture });
  let installation;
  try {
    installation = await invoke(page, "register_tool_installation", {
      request: {
        candidatePath: fixture,
        displayName: "Qutra Labs Fixture",
        category: "local",
        riskTier: "low",
        docUrl: "",
        tags: ["smoke"],
        workingDir: "",
        confirmed: true,
      },
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes("tool_already_registered")) throw error;
    const existing = await invoke(page, "list_tool_installations");
    installation = existing.find(
      (item) =>
        item.canonicalPath === fixture ||
        item.canonicalPath.replaceAll("/", "\\").endsWith("contextos-fixture.exe"),
    );
    if (!installation) throw error;
  }

  const marker = `packaged-native-${Date.now()}`;
  let run = await invoke(page, "start_tool_run", {
    request: {
      installationId: installation.id,
      profileId: "packaged-smoke-echo",
      requestId: `req-${Date.now()}`,
      argv: ["--mode", "echo", marker],
      workingDir: "",
      environment: [],
      redactions: [],
      requiresScope: false,
      timeoutSec: 30,
      outputLimitBytes: 65_536,
      concurrencyClass: "default",
    },
  });

  const runDeadline = Date.now() + 20_000;
  while (
    !["succeeded", "failed", "cancelled", "timed_out"].includes(run.state) &&
    Date.now() < runDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const runs = await invoke(page, "list_tool_runs");
    run = runs.find((item) => item.id === run.id) ?? run;
  }

  if (run.state !== "succeeded") {
    throw new Error(`Native run did not succeed: ${JSON.stringify(run)}`);
  }
  if (!run.pid || run.pid <= 0) {
    throw new Error(`Native run missing PID: ${JSON.stringify(run)}`);
  }

  await page.screenshot({
    path: path.resolve("e2e/screenshots/packaged-native-echo.png"),
    fullPage: false,
  });

  await stopSession(browser, child);
  browser = undefined;
  child = undefined;

  const second = await launch();
  child = second.child;
  browser = second.browser;
  const page2 = second.page;
  await skipOnboarding(page2);

  const persisted = await invoke(page2, "list_tool_installations");
  if (!persisted.some((item) => item.id === installation.id)) {
    throw new Error(
      `Tool installation did not persist across relaunch: ${JSON.stringify(persisted)}`,
    );
  }
  const persistedRuns = await invoke(page2, "list_tool_runs");
  if (!persistedRuns.some((item) => item.id === run.id && item.state === "succeeded")) {
    throw new Error(
      `Tool run history did not persist: ${JSON.stringify(persistedRuns)}`,
    );
  }

  await page2.screenshot({
    path: path.resolve("e2e/screenshots/packaged-native-output.png"),
    fullPage: false,
  });

  console.log(
    JSON.stringify({
      executable,
      fixture,
      bridgeKind,
      installationId: installation.id,
      runId: run.id,
      pid: run.pid,
      state: run.state,
      argv: run.argv,
      marker,
      persistedInstallations: persisted.length,
      persistedRuns: persistedRuns.length,
      screenshots: [
        path.resolve("e2e/screenshots/packaged-native-echo.png"),
        path.resolve("e2e/screenshots/packaged-native-output.png"),
      ],
    }),
  );
} finally {
  await stopSession(browser, child);
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(smokeRoot);
  if (
    resolved.startsWith(`${tempRoot}${path.sep}`) &&
    path.basename(resolved).startsWith("contextos-packaged-native-")
  ) {
    await rm(resolved, { recursive: true, force: true }).catch(() => {});
  }
}
