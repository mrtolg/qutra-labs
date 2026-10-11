import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const executable = process.env.CONTEXTOS_EXE;
if (!executable) throw new Error("CONTEXTOS_EXE is required");
const smokeIdentifier = "app.contextos.desktop.smoke";
if (!path.basename(executable).toLowerCase().includes("smoke")) {
  throw new Error(
    "Packaged smoke requires the dedicated Qutra Labs Smoke executable; refusing to launch a production profile.",
  );
}

const port = 9337;
const smokeRoot = path.join(
  os.tmpdir(),
  `contextos-packaged-smoke-${process.pid}-${Date.now()}`,
);
await mkdir(smokeRoot, { recursive: true });

const child = spawn(executable, [], {
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(smokeRoot, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: "ignore",
  windowsHide: true,
});

let browser;
let runtimeProfile;
try {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  let endpointReady = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        endpointReady = true;
        break;
      }
    } catch {
      // WebView2 is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!endpointReady) throw new Error("Packaged WebView CDP endpoint did not start");

  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page =
    context.pages().find((candidate) => candidate.url() !== "about:blank") ??
    context.pages()[0];
  if (!page) throw new Error("Packaged WebView page was not exposed");

  await page.waitForLoadState("domcontentloaded");
  const profileDeadline = Date.now() + 20_000;
  let profileError;
  while (!runtimeProfile && Date.now() < profileDeadline) {
    try {
      runtimeProfile = await page.evaluate(async () => {
        return window.__TAURI_INTERNALS__.invoke("runtime_profile");
      });
    } catch (error) {
      profileError = error;
      await page.waitForTimeout(250);
    }
  }
  if (!runtimeProfile) {
    throw new Error(
      `Packaged runtime profile was unavailable: ${String(profileError)}`,
    );
  }
  if (runtimeProfile.identifier !== smokeIdentifier) {
    throw new Error(
      `Packaged smoke isolation failed: ${JSON.stringify(runtimeProfile)}`,
    );
  }
  const skip = page.getByRole("button", {
    name: /^(Skip setup|Kurulumu atla)$/,
  });
  const sidebarLinks = page.locator(".ctx-sidebar-nav > .nav-group-items > a");
  const uiDeadline = Date.now() + 20_000;
  while (Date.now() < uiDeadline) {
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      break;
    }
    if (await sidebarLinks.first().isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  await page.locator('html[data-app-ready="true"]').waitFor({
    state: "attached",
    timeout: 20_000,
  });
  await sidebarLinks.first().waitFor({ state: "visible", timeout: 20_000 });
  const labels = await sidebarLinks.evaluateAll((links) =>
    links.map((link) => link.getAttribute("aria-label") ?? ""),
  );
  const expectedEnglish = [
    "Home",
    "Projects",
    "Files",
    "Tools",
    "Security Lab",
    "Terminal",
    "GitHub",
    "Qutra",
    "System",
  ];
  const expectedTurkish = [
    "Ana Sayfa",
    "Projeler",
    "Dosyalar",
    "Araçlar",
    "Güvenlik Laboratuvarı",
    "Terminal",
    "GitHub",
    "Qutra",
    "Sistem",
  ];
  if (
    JSON.stringify(labels) !== JSON.stringify(expectedEnglish) &&
    JSON.stringify(labels) !== JSON.stringify(expectedTurkish)
  ) {
    throw new Error(`Unexpected packaged navigation: ${JSON.stringify(labels)}`);
  }

  await page.locator('a[href="#/lab"]').click();
  await page.waitForURL(/#\/lab/);
  await page.locator("main").waitFor({ state: "visible" });
  const labTabs = page
    .getByRole("toolbar", { name: /Working tabs|Çalışma sekmeleri/ })
    .getByRole("button", { name: labels[4], exact: true });
  await labTabs.first().waitFor({ state: "visible" });
  if ((await labTabs.count()) !== 1) {
    throw new Error(`Packaged Lab navigation created ${await labTabs.count()} tabs`);
  }
  await page.locator('a[href="#/overview"]').click();
  await page.waitForURL(/#\/overview/);

  await page.screenshot({
    path: path.resolve("e2e/screenshots/packaged-simplified-overview.png"),
    fullPage: false,
  });
  let archiveDeleted = false;
  if (process.env.CONTEXTOS_SMOKE_DELETE_ARCHIVE === "1") {
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("delete_retired_archive");
    });
    archiveDeleted = true;
  }
  console.log(
    JSON.stringify({
      executable,
      pid: child.pid,
      runtimeProfile,
      labels,
      finalUrl: page.url(),
      archiveDeleted,
      screenshot: path.resolve(
        "e2e/screenshots/packaged-simplified-overview.png",
      ),
    }),
  );
} finally {
  await browser?.close().catch(() => {});
  if (child.pid && child.exitCode === null) child.kill();
  await new Promise((resolve) => setTimeout(resolve, 750));
  const tempRoot = path.resolve(os.tmpdir());
  const resolvedSmokeRoot = path.resolve(smokeRoot);
  if (
    resolvedSmokeRoot.startsWith(`${tempRoot}${path.sep}`) &&
    path.basename(resolvedSmokeRoot).startsWith("contextos-packaged-smoke-")
  ) {
    await rm(resolvedSmokeRoot, { recursive: true, force: true }).catch(() => {});
  }
  if (runtimeProfile?.identifier === smokeIdentifier) {
    const allowedRoots = [process.env.APPDATA, process.env.LOCALAPPDATA]
      .filter(Boolean)
      .map((root) => path.resolve(root));
    for (const candidate of [
      runtimeProfile.appConfigDir,
      runtimeProfile.appLocalDataDir,
    ]) {
      const resolved = path.resolve(candidate);
      const insideAllowedRoot = allowedRoots.some(
        (root) => resolved.startsWith(`${root}${path.sep}`),
      );
      if (
        insideAllowedRoot &&
        path.basename(resolved) === smokeIdentifier
      ) {
        await rm(resolved, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
