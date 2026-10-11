import { expect, type Page } from "@playwright/test";

/** Origin Playwright was given. Specs must not hard-code the dev-server port. */
export function requireBaseURL(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error("Playwright baseURL is unset");
  }
  return baseURL;
}

/** A request the page made that is not the app's own dev server. */
export function isOutsideApp(url: string, baseURL: string): boolean {
  const prefix = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  return url !== baseURL && !url.startsWith(prefix);
}

/** Skip onboarding and force a known locale/theme before the app boots. */
export async function primePreferences(
  page: Page,
  overrides: Record<string, unknown> = {},
) {
  await page.addInitScript((prefs) => {
    localStorage.setItem("contextos.v1.preferences", JSON.stringify(prefs));
  }, {
    locale: "en",
    theme: "light",
    density: "comfortable",
    onboardingDone: true,
    ...overrides,
  });
}

/** Load the demo dataset through the real Settings action. */
export async function loadDemo(page: Page) {
  await page.goto("/#/overview");
  const settings = await openSettings(page, "general");
  await settings.getByRole("button", { name: "Load demo data" }).click();
  await closeSettings(page);
  await waitForAppReady(page);
}

/** Open the Settings modal from the top bar's gear, at one section, or move
    to that section when it is already open. The app must already be on a
    page; Settings is a modal, not a route. */
export async function openSettings(page: Page, section: string) {
  const dialog = page.locator("dialog.settings-dialog[open]");
  if ((await dialog.count()) === 0) {
    await page.locator('button[aria-keyshortcuts="Control+Comma"]').click();
  }
  await dialog.locator(`[data-section="${section}"]`).click();
  await dialog
    .locator(`[data-section="${section}"][aria-current="true"]`)
    .waitFor();
  return dialog;
}

export async function closeSettings(page: Page) {
  const dialog = page.locator("dialog.settings-dialog[open]");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

/** Deterministic shell/font/paint readiness used before scans and screenshots. */
export async function waitForAppReady(page: Page) {
  await page.locator('html[data-app-ready="true"]').waitFor({
    state: "attached",
  });
  await page.locator("main").waitFor({ state: "visible" });
}

/** The labels of the New investigation dialog, per language. */
export const NEW_ENGAGEMENT = {
  en: { open: "New investigation", dialog: "New investigation", name: "Name", create: "Create" },
  tr: {
    open: "Yeni inceleme",
    dialog: "Yeni inceleme",
    name: "İncelemenin adı",
    create: "Oluştur",
  },
} as const;

/** Start an investigation the way a user does:
    New investigation, a name, Create. */
export async function newEngagement(
  page: Page,
  name = "Test engagement",
  labels: (typeof NEW_ENGAGEMENT)[keyof typeof NEW_ENGAGEMENT] = NEW_ENGAGEMENT.en,
) {
  await page.getByRole("button", { name: labels.open }).first().click();
  const dialog = page.getByRole("dialog", { name: labels.dialog });
  await dialog.getByLabel(labels.name, { exact: true }).fill(name);
  await dialog.getByRole("button", { name: labels.create }).click();
  await expect(dialog).toBeHidden();
}
