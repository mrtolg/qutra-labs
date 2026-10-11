import { expect, test, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { openSettings, waitForAppReady } from "./helpers";
import { seedLivedIn } from "./seedLivedIn";

/* Acceptance pass over the reported items: one screenshot per
   item at 1280 and 1920 px of a lived-in app (Turkish, dark HUD), and a sweep
   of every route and Settings section at 1024, 1280 and 1920 px that records
   clipped, overflowing and overlapping text. Evidence defaults to
   test-results/acceptance; a different folder can be named:
     $env:ACCEPTANCE_DIR='C:\...\acceptance'; npx playwright test e2e/acceptance.spec.ts */

const OUT = process.env.ACCEPTANCE_DIR ?? "test-results/acceptance";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T = 1_791_640_000_000;

/** Conversations with folders, a pin and an archived one; "naber" is open. */
function seedJarvis(page: Page) {
  const now = Date.now();
  const msg = (id: string, role: string, content: string, at: number) => ({
    id,
    role,
    content,
    createdAt: at,
    requestId: `r-${id}`,
  });
  const conv = (id: string, title: string, at: number, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    workspaceId: null,
    engagementId: null,
    origin: "chat",
    createdAt: at,
    updatedAt: at,
    lastOpenedAt: at - 1,
    eraseRevision: 0,
    messages: [msg(`${id}-q`, "user", title, at), msg(`${id}-a`, "assistant", `“${title}” için kısa bir yanıt.`, at)],
    ...extra,
  });
  const conversations = [
    { ...conv("c-naber", "naber", now - 5 * 60_000), lastOpenedAt: now },
    conv("c-nmap", "nmap -sV çıktısını yorumla", now - 2 * HOUR),
    conv("c-scope", "Ev laboratuvarı kapsamı", now - DAY - HOUR, { pinnedAt: now - DAY }),
    conv("c-acme-1", "ACME web uygulaması: giriş noktaları", now - 3 * DAY, { folderId: "f-acme" }),
    conv("c-acme-2", "ACME rapor taslağı", now - 4 * DAY, { folderId: "f-acme" }),
    conv("c-htb", "HTB makinesi notları", now - 6 * DAY, { folderId: "f-htb" }),
    conv("c-old", "Eski deneme", now - 20 * DAY, { archivedAt: now - DAY }),
  ];
  const folders = [
    { id: "f-acme", name: "Müşteri: ACME", createdAt: now - 5 * DAY, updatedAt: now - 5 * DAY },
    { id: "f-htb", name: "HackTheBox", createdAt: now - 7 * DAY, updatedAt: now - 7 * DAY },
  ];
  const memories = [
    { id: "m-1", text: "Laboratuvar ağım 10.10.0.0/24.", createdAt: now - 2 * DAY, updatedAt: now - 2 * DAY },
  ];
  return page.addInitScript(
    ({ conversations, folders, memories }) => {
      localStorage.setItem("contextos.v1.conversations", JSON.stringify(conversations));
      localStorage.setItem("contextos.v1.conversationFolders", JSON.stringify(folders));
      localStorage.setItem("contextos.v1.jarvisMemories", JSON.stringify(memories));
      const prefs = JSON.parse(localStorage.getItem("contextos.v1.preferences") ?? "{}");
      localStorage.setItem(
        "contextos.v1.preferences",
        JSON.stringify({ ...prefs, localAssistantEnabled: true }),
      );
    },
    { conversations, folders, memories },
  );
}

/** Registered programs through the development-only supervisor seam. */
function seedTools(page: Page) {
  const inst = (id: string, displayName: string, file: string, extra: Record<string, unknown> = {}) => ({
    id,
    displayName,
    runner: "executable",
    canonicalPath: `C:\\Tools\\${file}`,
    sha256: "f51fab8041e5023d7290b540a2106f051ef0bd2bc3443c9daf318628b560fa29",
    sizeBytes: 3_145_728,
    version: "",
    publisher: "",
    signatureState: "valid",
    category: "local",
    riskTier: "low",
    docUrl: "",
    tags: [],
    workingDir: "C:\\Tools",
    enabled: true,
    changedSinceVerify: false,
    createdAt: T,
    updatedAt: T,
    lastVerifiedAt: T,
    ...extra,
  });
  const installations = [
    inst("tool-nmap", "Nmap", "nmap.exe", { version: "7.99", category: "network", riskTier: "medium" }),
    inst("tool-tshark", "TShark", "tshark.exe", { version: "4.6.1" }),
    inst("tool-yara", "YARA", "yara64.exe", { version: "4.5.5" }),
    inst("tool-fixture", "ContextOS Fixture", "contextos-fixture.exe", { enabled: false, signatureState: "unsigned" }),
  ];
  return page.addInitScript(
    ({ installations }) => {
      (window as unknown as Record<string, unknown>).__QUTRA_E2E_TOOLS__ = {
        installations,
        runs: [],
        files: [],
        output: () => "",
        setEnabled: (id: string, enabled: boolean) => {
          const found = installations.find((i) => i.id === id)!;
          found.enabled = enabled;
          return found;
        },
        runForm: () => {
          throw new Error("not in this pass");
        },
      };
    },
    { installations },
  );
}

async function settle(page: Page) {
  await waitForAppReady(page);
  // Lazy page chunks show a skeleton until they have loaded.
  await page.locator(".skeleton").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  const close = page.locator(".toast-region .toast .btn--icon");
  while ((await close.count()) > 0) await close.first().click();
  await page.waitForTimeout(450);
}

async function boot(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await seedLivedIn(page);
  await seedJarvis(page);
  await seedTools(page);
}

for (const [width, height] of [
  [1280, 800],
  [1920, 1080],
] as const) {
  test(`reported items, evidence at ${width}px`, async ({ page }) => {
    test.setTimeout(300_000);
    mkdirSync(`${OUT}/items`, { recursive: true });
    const shot = (name: string) => page.screenshot({ path: `${OUT}/items/${name}-${width}.png` });
    const visit = async (route: string) => {
      await page.goto(route);
      await settle(page);
      await expect(page.getByRole("main")).toHaveCount(1);
    };
    await boot(page, width, height);

    // 1, 2: the history panel and the title row.
    await visit("/#/jarvis");
    await shot("01-02-jarvis-history-title");
    // 5: the model chip.
    const chip = page.getByTestId("jarvis-model-chip");
    if (await chip.count()) {
      await chip.click();
      await page.waitForTimeout(300);
      await shot("05-model-chip");
      await page.keyboard.press("Escape");
    }
    // 3, 4: Qutra's own settings: personalization, memory, model, keys.
    await page.getByRole("button", { name: "Qutra ayarları" }).click();
    await page.waitForTimeout(400);
    await shot("04-jarvis-settings-personal");
    const sheet = page.getByTestId("jarvis-settings");
    for (const [label, name] of [
      ["Hafıza", "04-jarvis-settings-memory"],
      ["Model", "03-05-jarvis-settings-model"],
      ["Bulut anahtarları", "04-jarvis-settings-keys"],
    ] as const) {
      await sheet.getByRole("button", { name: label, exact: true }).click();
      await page.waitForTimeout(300);
      await shot(name);
    }
    await page.keyboard.press("Escape");

    // 7, 9, 12: the registered program, its form and the fixture.
    await visit("/#/tools?view=registered&e=e-web");
    await shot("07-09-registered");
    for (const [tool, name] of [
      ["Nmap", "09-registered-nmap"],
      ["ContextOS Fixture", "12-fixture"],
    ] as const) {
      const row = page.locator(".lab-tool-row", { hasText: tool }).first();
      if (await row.count()) {
        await row.click();
        await page.waitForTimeout(400);
        await shot(name);
      }
    }
    // 13, 8: the launcher and a built-in utility on its bench.
    await visit("/#/tools?view=box&e=e-web");
    await shot("13-toolbox-top");
    const builtin = page.getByTestId("builtin-tool").first();
    if (await builtin.count()) {
      await builtin.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot("08-13-toolbox-builtin-list");
      await builtin.click();
      await page.getByTestId("builtin-bench").scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
      await shot("08-builtin-bench");
    }
    // 10, 11: sample data and the catalog.
    await visit("/#/tools?view=datasets&e=e-web");
    await shot("10-datasets");
    await visit("/#/tools?view=catalog");
    await shot("11-catalog");

    // 14–20: Settings.
    await visit("/#/overview");
    for (const [section, name] of [
      ["shortcuts", "14-shortcuts"],
      ["appearance", "15-appearance"],
      ["ai", "17-ai-providers"],
      ["permissions", "18-permissions"],
      ["privacy", "19-privacy"],
      ["languageRegion", "20-language-region"],
    ] as const) {
      const dialog = await openSettings(page, section);
      await page.waitForTimeout(350);
      await shot(name);
      if (section === "appearance") {
        // 16: a theme picked: the Apply bar stays in reach.
        const card = dialog.locator('[role="radio"]').nth(2);
        if (await card.count()) {
          await card.click();
          await dialog.locator('[data-scroll-owner="settings"]').evaluate((el) => el.scrollTo(0, 99_999));
          await page.waitForTimeout(300);
          await shot("16-appearance-apply-bar");
          const cancel = dialog.getByRole("button", { name: "Vazgeç" });
          if (await cancel.count()) await cancel.first().click();
        }
      }
    }
    await page.keyboard.press("Escape");

    // 21: the pages with their own layout.
    for (const [route, name] of [
      ["/#/overview", "21-home"],
      ["/#/lab?list=1", "21-investigations"],
      ["/#/lab?e=e-web&view=overview", "21-investigation"],
      ["/#/terminal", "21-terminal"],
    ] as const) {
      await visit(route);
      await shot(name);
    }
  });
}

/* The sweep. In the page: text cut off by its own box or an ancestor that
   clips (not an intended ellipsis), text outside the window, the page
   scrolling sideways, and text boxes drawn over each other. */
function findDefects() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  type Finding = { kind: string; el: string; text: string; detail?: string };
  const out: Finding[] = [];
  const root = document.querySelector("dialog:modal") ?? document.body;
  const label = (el: Element) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + (cls ? `.${cls}` : "");
  };
  const words = (el: Element) => ((el as HTMLElement).innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const shown = (el: Element) => {
    const collapsed = el.closest("details:not([open])");
    if (collapsed && !collapsed.querySelector(":scope > summary")?.contains(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const ownText = (el: Element) =>
    [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0);
  const scrolls = (v: string) => v === "auto" || v === "scroll";
  const truncates = (el: Element | null) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.textOverflow === "ellipsis" || s.webkitLineClamp !== "none") return true;
    }
    return false;
  };

  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    out.push({ kind: "page-scrolls-sideways", el: "html", text: "", detail: `${document.documentElement.scrollWidth}px` });
  }
  const leaves: { el: Element; r: DOMRect }[] = [];
  for (const el of root.querySelectorAll("*")) {
    if (!ownText(el) || !shown(el)) continue;
    if (el.closest(".sr-only, [aria-hidden='true'], script, style, .xterm, [inert]")) continue;
    if (el.matches(".skip-link:not(:focus)")) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (s.overflowX !== "visible" && !scrolls(s.overflowX) && el.scrollWidth > el.clientWidth + 1 && !truncates(el)) {
      out.push({ kind: "text-cut-x", el: label(el), text: words(el), detail: `${el.scrollWidth}>${el.clientWidth}` });
    }
    if (s.overflowY !== "visible" && !scrolls(s.overflowY) && el.scrollHeight > el.clientHeight + 2 && !truncates(el)) {
      out.push({ kind: "text-cut-y", el: label(el), text: words(el), detail: `${el.scrollHeight}>${el.clientHeight}` });
    }
    const scrollsHorizontally = (() => {
      for (let a = el.parentElement; a; a = a.parentElement) {
        if (scrolls(getComputedStyle(a).overflowX)) return true;
      }
      return false;
    })();
    if ((r.right > vw + 1 || r.left < -1) && !scrollsHorizontally) {
      out.push({ kind: "text-off-window", el: label(el), text: words(el), detail: `${Math.round(r.left)}..${Math.round(r.right)}` });
    }
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.overflowX === "visible" && as.overflowY === "visible") continue;
      if (scrolls(as.overflowX) || scrolls(as.overflowY)) break;
      const ar = a.getBoundingClientRect();
      if ((r.left < ar.left - 1 || r.right > ar.right + 1) && !truncates(el)) {
        out.push({ kind: "text-cut-by-box", el: label(el), text: words(el), detail: label(a) });
      }
      break;
    }
    let left = Math.max(r.left, 0);
    let right = Math.min(r.right, vw);
    let top = Math.max(r.top, 0);
    let bottom = Math.min(r.bottom, vh);
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const style = getComputedStyle(a);
      const box = a.getBoundingClientRect();
      if (style.overflowX !== "visible") {
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
    }
    if (right > left && bottom > top) {
      leaves.push({ el, r: new DOMRect(left, top, right - left, bottom - top) });
    }
  }
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i]!;
      const b = leaves[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 3 || h <= 3) continue;
      const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if ((w * h) / smaller < 0.25) continue;
      out.push({ kind: "text-overlaps", el: `${label(a.el)} × ${label(b.el)}`, text: `${words(a.el)} × ${words(b.el)}` });
    }
  }
  return out;
}

const ROUTES: [string, string][] = [
  ["home", "/#/overview"],
  ["projects", "/#/workspaces"],
  ["files", "/#/files"],
  ["github", "/#/github"],
  ["investigations", "/#/lab?list=1"],
  ["inv-overview", "/#/lab?e=e-web&view=overview"],
  ["inv-targets", "/#/lab?e=e-web&view=targets"],
  ["inv-runs", "/#/lab?e=e-web&view=runs"],
  ["inv-evidence", "/#/lab?e=e-web&view=evidence"],
  ["inv-findings", "/#/lab?e=e-web&view=findings"],
  ["inv-report", "/#/lab?e=e-web&view=report"],
  ["inv-scope", "/#/lab?e=e-host&view=scope"],
  ["toolbox", "/#/tools?view=box&e=e-web"],
  ["registered", "/#/tools?view=registered&e=e-web"],
  ["catalog", "/#/tools?view=catalog"],
  ["playbooks", "/#/tools?view=playbooks"],
  ["datasets", "/#/tools?view=datasets&e=e-web"],
  ["jarvis", "/#/jarvis"],
  ["terminal", "/#/terminal"],
];
const SECTIONS = [
  "general",
  "appearance",
  "languageRegion",
  "shortcuts",
  "capture",
  "privacy",
  "permissions",
  "ai",
  "storage",
  "importExport",
  "notifications",
  "advanced",
  "about",
];

for (const [width, height] of [
  [1024, 768],
  [1280, 800],
  [1920, 1080],
] as const) {
  test(`visual sweep at ${width}px`, async ({ page }) => {
    test.setTimeout(420_000);
    mkdirSync(`${OUT}/sweep`, { recursive: true });
    const found: Record<string, unknown[]> = {};
    const check = async (name: string) => {
      const defects = await page.evaluate(findDefects);
      found[name] = defects;
      await page.screenshot({ path: `${OUT}/sweep/${width}-${name}.png` });
    };
    await boot(page, width, height);
    for (const [name, route] of ROUTES) {
      await page.goto(route);
      await settle(page);
      await check(name);
    }
    await page.goto("/#/jarvis");
    await settle(page);
    await page.getByRole("button", { name: "Qutra ayarları" }).click();
    await page.waitForTimeout(400);
    await check("jarvis-settings");
    await page.keyboard.press("Escape");

    await page.goto("/#/overview");
    await settle(page);
    for (const section of SECTIONS) {
      await openSettings(page, section);
      await page.waitForTimeout(300);
      await check(`settings-${section}`);
    }
    writeFileSync(`${OUT}/sweep/defects-${width}.json`, JSON.stringify(found, null, 2));
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(Object.entries(found).filter(([, defects]) => defects.length > 0)).toEqual([]);
  });
}
