import { expect, test } from "@playwright/test";
import { loadDemo, primePreferences } from "./helpers";

/* The global `* { margin: 0 }` reset used to zero the auto margins a modal
   <dialog> relies on, so every dialog opened pinned to the top-left corner.
   Every functional test still passed: they find dialogs by role, not place. */

async function expectCentredHorizontally(
  page: import("@playwright/test").Page,
  selector: string,
) {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  const centre = box!.x + box!.width / 2;
  expect(Math.abs(centre - viewport.width / 2)).toBeLessThan(2);
}

test("modal dialogs open centred, not in the corner", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await primePreferences(page);
  await loadDemo(page);

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expectCentredHorizontally(page, "dialog.palette");

  await page.getByRole("option", { name: /Capture context/ }).first().click();
  await expect(page.locator("dialog.dialog[open]")).toBeVisible();
  await expectCentredHorizontally(page, "dialog.dialog[open]");
});
