import { expect, test } from "@playwright/test";
import { loadDemo, primePreferences, waitForAppReady } from "./helpers";

const HUD = { theme: "system", packId: "hud", themeMode: "dark", material: "none" };

/* Spec 2026-10-07 §5.2: Home opens with what to investigate, by kind, with a
   terminal and Qutra beside it; the old greeting is gone. */
test("Home starts a new investigation by kind", async ({ page }) => {
  await primePreferences(page, HUD);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/overview");
  await waitForAppReady(page);

  const main = page.locator("main");
  await expect(main.getByText(/Good (morning|afternoon|evening)/)).toHaveCount(0);
  const start = main.getByRole("region", { name: "New investigation" });
  await expect(start.getByRole("button")).toHaveText([
    "File",
    "Web application",
    "Host or network",
    "PCAP",
    "Forensics",
    "New terminal",
    "Ask Qutra",
  ]);

  await start.getByRole("button", { name: "PCAP" }).click();
  // Nothing is made before the user names it.
  await expect(page).toHaveURL(/#\/lab\?new=1&kind=pcap$/);
  const dialog = page.getByRole("dialog", { name: "New investigation" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("What are you investigating?")).toHaveValue("pcap");
});

test("Home offers the most recent project as a link to resume", async ({ page }) => {
  await primePreferences(page, HUD);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loadDemo(page);

  const main = page.locator("main");
  const resume = main.getByRole("region", { name: "Resume where you left off" });
  const link = resume.getByRole("link", { name: /^Project · / });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/#\/workspaces\/[^/]+$/);
});
