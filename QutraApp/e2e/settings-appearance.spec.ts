import { expect, test, type Page } from "@playwright/test";
import { closeSettings, openSettings, primePreferences, waitForAppReady } from "./helpers";

/* No window effects, an Apply that is always
   in reach and really applies, and shortcuts that can be changed. */

const HUD_WITH_OLD_EFFECT = {
  theme: "system",
  packId: "hud",
  themeMode: "dark",
  // Stored by an older version; must read as the flat window.
  material: "mica",
};

/** primePreferences, but only on the first load, so a reload reads what the app stored. */
async function primeOnce(page: Page, prefs: Record<string, unknown>) {
  await page.addInitScript((stored) => {
    if (sessionStorage.getItem("e2e.primed")) return;
    sessionStorage.setItem("e2e.primed", "1");
    localStorage.setItem("contextos.v1.preferences", JSON.stringify(stored));
  }, { locale: "en", density: "comfortable", onboardingDone: true, ...prefs });
}

test("appearance: no window effects, Apply stays in reach and the theme stays applied", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await primeOnce(page, HUD_WITH_OLD_EFFECT);
  await page.goto("/#/overview");
  await waitForAppReady(page);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-pack", "hud");
  await expect(html).not.toHaveAttribute("data-native-backdrop", /.*/);

  const settings = await openSettings(page, "appearance");
  await expect(settings.getByText(/Mica|Acrylic|Liquid Glass/)).toHaveCount(0);
  await expect(settings.getByRole("radio")).toHaveCount(4);
  await page.screenshot({ path: "e2e/screenshots/settings-appearance-1280.png" });

  await settings.getByRole("radio", { name: "Catppuccin" }).click();
  await expect(html).toHaveAttribute("data-pack", "catppuccin");
  // The pane scrolls to its end; the Apply bar is still on screen.
  await settings.locator(".settings-pane").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const apply = settings.getByRole("button", { name: "Apply" });
  await expect(apply).toBeInViewport();
  await page.screenshot({ path: "e2e/screenshots/settings-appearance-preview-1280.png" });

  await apply.click();
  await expect(apply).toHaveCount(0);
  await closeSettings(page);
  await expect(html).toHaveAttribute("data-pack", "catppuccin");

  await page.reload();
  await waitForAppReady(page);
  await expect(html).toHaveAttribute("data-pack", "catppuccin");
  await page.screenshot({ path: "e2e/screenshots/settings-appearance-applied-1280.png" });
});

test("appearance: an unapplied preview is dropped when Settings closes", async ({ page }) => {
  await primePreferences(page, HUD_WITH_OLD_EFFECT);
  await page.goto("/#/overview");
  await waitForAppReady(page);
  const settings = await openSettings(page, "appearance");
  await settings.getByRole("radio", { name: "Qutra Labs" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-pack", "contextos");
  await closeSettings(page);
  await expect(page.locator("html")).toHaveAttribute("data-pack", "hud");
});

test("shortcuts: grouped, rebindable, and a conflict asks first", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await primePreferences(page, { theme: "system", packId: "hud", themeMode: "dark" });
  await page.goto("/#/overview");
  await waitForAppReady(page);

  const settings = await openSettings(page, "shortcuts");
  for (const group of ["Navigation", "Jarvis", "Investigations", "Terminal", "General"]) {
    await expect(settings.getByRole("group", { name: new RegExp(`^${group}`) })).toBeVisible();
  }
  await page.screenshot({ path: "e2e/screenshots/settings-shortcuts-1280.png" });

  // Taking Ctrl+K from the palette asks first.
  await settings.getByRole("button", { name: /^Open Home: Alt\+Home/ }).click();
  await page.keyboard.press("Control+k");
  const conflict = settings.getByRole("alert");
  await expect(conflict).toContainText("Ctrl+K is used by “Command palette”");
  await page.screenshot({ path: "e2e/screenshots/settings-shortcuts-conflict-1280.png" });
  await conflict.getByRole("button", { name: "Cancel" }).click();

  // Give the palette a new combination; the app answers to it at once.
  await settings.getByRole("button", { name: /^Command palette: Ctrl\+K/ }).click();
  await page.keyboard.press("Control+Shift+P");
  await expect(settings.getByRole("button", { name: /^Command palette: Ctrl\+Shift\+P/ })).toBeVisible();
  await closeSettings(page);

  await page.keyboard.press("Control+k");
  await expect(page.locator("dialog.palette")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator("dialog.palette")).toBeVisible();
  await expect(page.getByRole("button", { name: "Search", exact: true }).locator("kbd")).toHaveText("Ctrl Shift P");
});

test("shortcuts: the Turkish list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await primePreferences(page, { locale: "tr", theme: "system", packId: "hud", themeMode: "dark" });
  await page.goto("/#/overview");
  await waitForAppReady(page);
  await page.locator('button[aria-keyshortcuts="Control+Comma"]').click();
  const settings = page.locator("dialog.settings-dialog[open]");
  await settings.locator('[data-section="shortcuts"]').click();
  await expect(settings.getByRole("group", { name: /^Gezinme/ })).toBeVisible();
  await settings.getByRole("button", { name: /^Ayarlar: Ctrl\+,/ }).click();
  await page.keyboard.press("Alt+F4");
  await expect(settings.getByRole("alert")).toContainText("Alt+F4 atanamaz");
  await page.screenshot({ path: "e2e/screenshots/settings-shortcuts-tr-1280.png" });
});
