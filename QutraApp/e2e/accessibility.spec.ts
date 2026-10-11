import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { LAB_VIEWS } from "../src/domain/workbench";
import { SETTINGS_SECTIONS } from "../src/features/settings/sections";
import {
  closeSettings,
  loadDemo,
  openSettings,
  primePreferences,
  waitForAppReady,
} from "./helpers";

/* WCAG 2.2 AA, checked by axe on the DOM the app actually renders.

   Home is scanned in every pack and mode. Every route — each Lab view, each
   Settings section and each project tab included — is scanned in the modes
   the product ships as its identity: hud dark, hud light and high contrast.
   A review found white text on --danger in the Lab while this file scanned
   Home only; a per-token test cannot see a pair that only one route renders. */

const WCAG22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const MATRIX = [
  ["hud", "light"],
  ["hud", "dark"],
  ["contextos", "light"],
  ["contextos", "dark"],
  ["catppuccin", "light"],
  ["catppuccin", "dark"],
  ["highContrast", "light"],
  ["highContrast", "dark"],
] as const;

const ROUTE_MODES = [
  ["hud", "dark"],
  ["hud", "light"],
  ["highContrast", "dark"],
  ["highContrast", "light"],
] as const;

async function prime(page: Page, packId: string, themeMode: string) {
  await primePreferences(page, {
    theme: "system",
    packId,
    themeMode,
    material: "none",
    highContrast: packId === "highContrast",
    reduceMotion: true,
  });
}

async function violations(page: Page) {
  const scan = await new AxeBuilder({ page }).withTags(WCAG22_AA).analyze();
  return scan.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      summary: node.failureSummary,
    })),
  }));
}

/** Every route the router serves, with the ids the demo data gives it. */
async function allRoutes(page: Page): Promise<string[]> {
  await page.goto("/#/workspaces");
  await waitForAppReady(page);
  // Project rows and tabs navigate on click; they carry no href to read.
  await page.locator("main tbody tr").first().click({ timeout: 10_000 });
  await expect(page).toHaveURL(/#\/workspaces\/[^/?]+$/);
  const hashPath = () => decodeURIComponent(new URL(page.url()).hash.slice(1));
  const project = hashPath();
  const tabs = page.locator('main [role="tablist"] [role="tab"]');
  await tabs.first().waitFor({ timeout: 10_000 });
  const tabCount = await tabs.count();
  expect(tabCount, "the project page has tabs").toBeGreaterThan(3);
  const projectTabs: string[] = [];
  for (let i = 1; i < tabCount; i++) {
    await tabs.nth(i).click({ timeout: 10_000 });
    await expect(tabs.nth(i)).toHaveAttribute("aria-selected", "true");
    projectTabs.push(hashPath());
  }

  return [
    "/overview",
    "/workspaces",
    project,
    ...projectTabs,
    "/sessions/focus",
    "/files",
    "/terminal",
    "/jarvis",
    "/github",
    "/tools",
    ...LAB_VIEWS.map((view) => `/lab?view=${view}`),
    ...SETTINGS_SECTIONS.map((section) => `settings:${section}`),
  ];
}

/** Show one entry of `allRoutes`: a route, or a section of the Settings
    modal (`settings:<section>`), which opens over Home. */
async function visit(page: Page, target: string) {
  const settingsOpen = page.locator("dialog.settings-dialog[open]");
  if (target.startsWith("settings:")) {
    if ((await settingsOpen.count()) === 0) {
      await page.goto("/#/overview");
      await waitForAppReady(page);
    }
    await openSettings(page, target.slice("settings:".length));
  } else {
    if ((await settingsOpen.count()) > 0) await closeSettings(page);
    await page.goto(`/#${target}`);
    await waitForAppReady(page);
  }
  // A lazy route shows an aria-busy skeleton until its chunk arrives.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

for (const [packId, themeMode] of MATRIX) {
  test(`WCAG 2.2 AA DOM gate, Home: ${packId} / ${themeMode}`, async ({ page }) => {
    await prime(page, packId, themeMode);
    await loadDemo(page);
    await page.goto("/#/overview");
    await waitForAppReady(page);
    expect(await violations(page)).toEqual([]);
  });
}

for (const [packId, themeMode] of ROUTE_MODES) {
  test(`WCAG 2.2 AA DOM gate, every route: ${packId} / ${themeMode}`, async ({ page }) => {
    test.setTimeout(240_000);
    await prime(page, packId, themeMode);
    await loadDemo(page);
    const routes = await allRoutes(page);

    const found: Record<string, unknown> = {};
    for (const route of routes) {
      await visit(page, route);
      const list = await violations(page);
      if (list.length > 0) found[route] = list;
    }
    expect(found).toEqual({});
  });
}

/* The context panel is on demand, so the route scan above never sees
   it open. Each segment is scanned with the panel open over a Lab view. */
for (const [packId, themeMode] of ROUTE_MODES) {
  test(`WCAG 2.2 AA DOM gate, context panel: ${packId} / ${themeMode}`, async ({ page }) => {
    await prime(page, packId, themeMode);
    await loadDemo(page);
    await page.goto("/#/lab?view=runs");
    await waitForAppReady(page);
    await page.getByRole("button", { name: "Context panel" }).click();
    const panel = page.getByRole("complementary", { name: "Context" });
    const found: Record<string, unknown> = {};
    for (const segment of ["Project", "Files", "Repo", "Runs output"]) {
      await panel.getByRole("tab", { name: segment }).click();
      const list = await violations(page);
      if (list.length > 0) found[segment] = list;
    }
    expect(found).toEqual({});
  });
}

/* Acceptance criterion 5: every input has a label a sighted user can read. axe accepts
   aria-label and title, which nobody sees; a placeholder vanishes as soon as
   the user types. Only a visible <label> or a visible aria-labelledby target
   counts here. */
async function inputsWithoutVisibleLabel(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const painted = (el: Element) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 1 && box.height > 1 && style.visibility !== "hidden" && style.opacity !== "0";
    };
    // Only text that is itself painted names the field. A label that wraps
    // its input is large, and its textContent includes an .sr-only span that
    // is clipped to 1 px, so neither the box nor the text proves anything.
    const shown = (el: Element | null) => {
      if (!el || !painted(el)) return false;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? "").trim()) continue;
        if (node.parentElement?.closest("textarea, select, option")) continue;
        let parent = node.parentElement;
        let visible = true;
        while (parent && parent !== el) {
          if (!painted(parent)) {
            visible = false;
            break;
          }
          parent = parent.parentElement;
        }
        if (visible) return true;
      }
      return false;
    };
    const fields = document.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]), textarea, select, [role="textbox"], [role="searchbox"], [role="combobox"]',
    );
    const missing: string[] = [];
    for (const field of fields) {
      // A visually hidden input (a file picker behind a visible button) is
      // operated through that button, which carries the visible text.
      const rect = field.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      if (field.closest('[aria-hidden="true"], .xterm')) continue;
      const labels = "labels" in field ? Array.from((field as HTMLInputElement).labels ?? []) : [];
      const labelledBy = (field.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id));
      if (labels.some(shown) || labelledBy.some(shown)) continue;
      missing.push(
        field.getAttribute("aria-label") ||
          field.getAttribute("placeholder") ||
          field.getAttribute("name") ||
          field.outerHTML.slice(0, 80),
      );
    }
    return missing;
  });
}

test("every input on every route has a visible label", async ({ page }) => {
  test.setTimeout(240_000);
  // Private Lab on, so the Lab and Tools routes render their real fields.
  await primePreferences(page, {
    packId: "hud",
    themeMode: "dark",
    material: "none",
    reduceMotion: true,
    privateToolsEnabled: true,
  });
  await loadDemo(page);
  const routes = await allRoutes(page);

  const found: Record<string, string[]> = {};
  for (const route of routes) {
    await visit(page, route);
    const missing = await inputsWithoutVisibleLabel(page);
    if (missing.length > 0) found[route] = missing;
  }
  expect(found).toEqual({});
});

/* The GitHub repository search passed the check above while its
   only label text was an .sr-only span. This is that markup, next to a Field. */
test("a label whose only text is visually hidden does not count", async ({ page }) => {
  await prime(page, "hud", "dark");
  await page.goto("/#/overview");
  await waitForAppReady(page);
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.innerHTML =
      '<label class="github-repo-search"><svg aria-hidden="true" width="14" height="14"></svg>' +
      '<span class="sr-only">Repositories</span><input placeholder="Repositories..." /></label>' +
      '<div class="field"><label for="label-check-visible">Search repositories</label>' +
      '<input id="label-check-visible" placeholder="Visible label case" /></div>';
    document.body.appendChild(host);
  });

  const missing = await inputsWithoutVisibleLabel(page);

  expect(missing).toContain("Repositories...");
  expect(missing).not.toContain("Visible label case");
});

test("the GitHub repository search keeps a visible name while the user types", async ({ page }) => {
  await prime(page, "hud", "dark");
  await page.goto("/#/github");
  await waitForAppReady(page);
  await page.getByRole("button", { name: "Preview with demo data" }).click();

  const search = page.getByLabel("Search repositories");
  await search.fill("sigma");

  await expect(page.locator("label", { hasText: "Search repositories" })).toBeVisible();
  expect(await inputsWithoutVisibleLabel(page)).toEqual([]);
});

test("keyboard focus is always visible on Home", async ({ page }) => {
  await prime(page, "hud", "dark");
  await loadDemo(page);
  await page.goto("/#/overview");
  await waitForAppReady(page);

  const invisible: string[] = [];
  let checked = 0;
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const outline =
        style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
      const ring = style.boxShadow !== "none" && style.boxShadow !== "";
      const name =
        el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40) || el.tagName;
      return { visible: outline || ring, name };
    });
    if (!focus) continue;
    checked += 1;
    if (!focus.visible) invisible.push(focus.name);
  }
  expect(checked, "Tab reached the controls").toBeGreaterThanOrEqual(10);
  expect(invisible).toEqual([]);
});
