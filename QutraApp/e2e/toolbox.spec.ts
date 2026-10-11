import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { primePreferences, waitForAppReady } from "./helpers";

/* Araç kutusu, looked at the way a user
   sees it: the desktop app with registered programs. The page runs on a
   stand-in for the native side that answers the few commands this page asks
   (the document store, the consent, the registered programs, the logos). It
   never runs a program; nothing here reaches the network. */

const NOW = 1_791_400_000_000;

function installation(id: string, displayName: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    displayName,
    runner: "executable",
    canonicalPath: `\\\\?\\C:\\Tools\\${displayName}\\${displayName.toLowerCase()}.exe`,
    sha256: "9f2c4d1be07a53c8f6e1d20b4a7c95e3f18d6b20ac4e97f35d0b1c8e62a9f471",
    sizeBytes: 2_977_792,
    version: "",
    publisher: "",
    signatureState: "valid",
    category: "network",
    riskTier: "medium",
    docUrl: "",
    tags: [],
    workingDir: `\\\\?\\C:\\Tools\\${displayName}`,
    enabled: true,
    changedSinceVerify: false,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    lastVerifiedAt: NOW - 3_600_000,
    ...extra,
  };
}

/** Programs like a typical setup: some linked, many registered but not linked,
    one changed on disk, and two of the user's own. */
const INSTALLATIONS = [
  installation("tool-nmap", "Nmap", { version: "7.95" }),
  installation("tool-wireshark", "Wireshark", { version: "4.4.1", category: "network" }),
  installation("tool-ghidra", "Ghidra", { version: "11.2", category: "dfir" }),
  installation("tool-die", "Detect It Easy", { version: "3.10", category: "dfir" }),
  installation("tool-tshark", "TShark 4.4.1"),
  installation("tool-yara", "YARA 4.5.2", { category: "dfir" }),
  installation("tool-exiftool", "ExifTool 13.0", { category: "dfir" }),
  installation("tool-vol", "Volatility 3", { category: "dfir" }),
  installation("tool-jq", "jq 1.7.1", { category: "local", docUrl: "https://github.com/jqlang/jq" }),
  installation("tool-hashcat", "hashcat 6.2.6", { category: "local" }),
  installation("tool-zap", "ZAP 2.15", { category: "web", changedSinceVerify: true }),
  installation("tool-capinfos", "capinfos", {
    docUrl: "https://www.wireshark.org/docs/man-pages/capinfos.html",
  }),
  installation("tool-acme", "Acme Recon", { docUrl: "https://github.com/acme-sec/recon" }),
];

const BINDINGS = [
  ["nmap", "tool-nmap"],
  ["wireshark", "tool-wireshark"],
  ["ghidra", "tool-ghidra"],
  ["detect-it-easy", "tool-die"],
  ["zap", "tool-zap"],
].map(([catalogId, installationId]) => ({
  id: installationId,
  catalogId,
  installationId,
  confirmedAt: NOW - 86_400_000,
}));

/** What Rust would hand back for jq once fetched: its organization avatar,
    re-encoded as the app's own 64 px PNG. */
const JQ_LOGO = `data:image/png;base64,${readFileSync("src/assets/tool-logos/jq.png").toString("base64")}`;

const ENGAGEMENT = {
  id: "eng-acme",
  title: "Acme web uygulaması",
  status: "active",
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
};

async function fakeDesktop(page: Page, locale: "en" | "tr") {
  await page.addInitScript(
    ({ installations, bindings, engagement, locale, now, jqLogo }) => {
      const prefs = {
        locale,
        theme: "dark",
        density: "comfortable",
        onboardingDone: true,
        privateToolsEnabled: true,
      };
      const records = [
        ...bindings.map((b) => ({
          collection: "installationBindings",
          id: b.id,
          data: JSON.stringify(b),
        })),
        { collection: "engagements", id: engagement.id, data: JSON.stringify(engagement) },
      ];
      let callback = 0;
      const answer = (cmd: string, args: Record<string, unknown> | undefined): unknown => {
        switch (cmd) {
          case "storage_load":
            return { records, kv: [{ key: "preferences", value: JSON.stringify(prefs) }] };
          case "storage_apply_writes":
            return null;
          case "plugin:event|listen":
            return ++callback;
          case "private_tools_consent":
            return true;
          case "list_tool_installations":
            return installations;
          case "list_tool_runs":
          case "list_active_tool_runs":
          case "tool_launches_list":
          case "tool_logos_list":
          case "terminal_list_sessions":
            return [];
          case "tool_logo_fetch":
            return args?.id === "tool-jq"
              ? {
                  installationId: "tool-jq",
                  state: "found",
                  dataUrl: jqLogo,
                  source: "https://avatars.githubusercontent.com/u/104800540?v=4&s=128",
                  plate: "none",
                }
              : {
                  installationId: args?.id,
                  state: "none",
                  dataUrl: null,
                  source: null,
                  plate: null,
                };
          case "abandon_previous_renderer":
            return { cancelledTurn: false, closedSessions: 0 };
          default:
            return null;
        }
      };
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { windowLabel: "main", label: "main" },
          },
          plugins: {},
          transformCallback: () => ++callback,
          unregisterCallback: () => undefined,
          convertFileSrc: (path: string) => path,
          invoke: async (cmd: string, args?: Record<string, unknown>) => answer(cmd, args),
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      });
      Date.now = () => now;
    },
    {
      installations: INSTALLATIONS,
      bindings: BINDINGS,
      engagement: ENGAGEMENT,
      locale,
      now: NOW,
      jqLogo: JQ_LOGO,
    },
  );
}

test.describe("Araç kutusu on the desktop", () => {
  for (const locale of ["tr", "en"] as const) {
    test(`ready programs first, one step for the rest (${locale})`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await fakeDesktop(page, locale);
      await page.goto("/#/tools");
      await waitForAppReady(page);

      const ready = locale === "tr" ? "Kullanıma hazır" : "Ready to use";
      await expect(page.getByRole("heading", { name: new RegExp(ready) })).toBeVisible();
      const nmap = page.getByRole("listitem", { name: "Nmap" });
      await expect(nmap.locator("img")).toHaveAttribute("src", /nmap\.png/);
      await expect(page.getByRole("listitem", { name: "TShark" }).locator("img")).toHaveAttribute(
        "src",
        /wireshark\.png/,
      );
      await page.screenshot({ path: `e2e/screenshots/${locale}-toolbox-top.png` });
    });
  }

  test("the readiness strip filters, and suggestions link in one step", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fakeDesktop(page, "tr");
    await page.goto("/#/tools");
    await waitForAppReady(page);

    const legend = page.getByRole("group", { name: "Duruma göre süz" });
    await legend.getByRole("button", { name: /^Bağlı değil/ }).click();
    await expect(page.getByTestId("tool-tile").first()).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/tr-toolbox-unlinked.png" });

    await page.getByRole("button", { name: /^Önerilen \d+ kaydı bağla$/ }).click();
    const dialog = page.getByRole("dialog", { name: "Önerilen kayıtları bağla" });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/tr-toolbox-link-all.png" });
  });

  test("a guide opens in place", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fakeDesktop(page, "tr");
    await page.goto("/#/tools");
    await waitForAppReady(page);

    await page
      .getByRole("listitem", { name: "Nmap" })
      .getByRole("button", { name: "Kılavuz" })
      .click();
    await expect(page.getByRole("dialog", { name: "Nmap kılavuzu" })).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/tr-toolbox-guide.png" });
  });

  test("a built-in tool opens on the bench, found with the page's search", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fakeDesktop(page, "tr");
    await page.goto("/#/tools");
    await waitForAppReady(page);

    await page.getByTestId("builtin-tool").filter({ hasText: "JWT" }).click();
    const bench = page.getByTestId("builtin-bench");
    await expect(bench).toBeVisible();
    await bench.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "e2e/screenshots/tr-toolbox-builtins.png" });

    await page.getByLabel("Araçlarda ara").fill("regex");
    await expect(page.getByTestId("builtin-tool")).toHaveCount(1);
  });

  test("the user's own programs get their logos only when asked", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fakeDesktop(page, "tr");
    await page.goto("/#/tools");
    await waitForAppReady(page);

    await page.getByText("Kataloğun dışındaki kayıtlı programlarınız").click();
    const jq = page.getByRole("listitem", { name: "jq 1.7.1" });
    await expect(jq.locator(".tlogo--letter")).toHaveText("J");
    const find = page.getByRole("button", { name: "Logoları bul (3)" });
    await expect(page.getByText(/github\.com, wireshark\.org/)).toBeVisible();
    await find.click();
    await expect(jq.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await jq.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "e2e/screenshots/tr-toolbox-own-programs.png" });
  });

  test("at 1920 px the page stays readable", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await fakeDesktop(page, "tr");
    await page.goto("/#/tools");
    await waitForAppReady(page);
    await expect(page.getByRole("listitem", { name: "Nmap" })).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/tr-toolbox-1920.png" });
  });
});

test.describe("Araç kutusu in the browser build", () => {
  test("every program still offers its download page and a guide", async ({ page }) => {
    await primePreferences(page, { locale: "tr", theme: "dark", privateToolsEnabled: true });
    await page.goto("/#/tools");
    await waitForAppReady(page);
    await expect(page.getByTestId("launcher-browser-notice")).toBeVisible();
    await expect(page.getByTestId("tool-tile")).toHaveCount(35);
    await page.screenshot({ path: "e2e/screenshots/tr-toolbox-browser.png" });
  });
});
