import { expect, test, type Page } from "@playwright/test";
import { primePreferences, waitForAppReady } from "./helpers";

/* ============================================================
   Top bar: every surface is reachable by click and by key, and the
   bar never truncates at the window minimum (960 px, tauri.conf.json) even
   with German labels, which run about 30% longer than English.
   ============================================================ */

const surfaces = (page: Page) =>
  page.getByRole("navigation", { name: "Surfaces" });

test("each surface opens from the switcher and from Ctrl+1–4", async ({
  page,
}) => {
  await primePreferences(page, {
    theme: "system",
    packId: "hud",
    themeMode: "dark",
    material: "none",
  });
  await page.goto("/#/overview");
  await waitForAppReady(page);

  for (const [name, hash] of [
    ["Investigations", "#/lab"],
    ["Tools", "#/tools"],
    ["Qutra", "#/jarvis"],
    ["Terminal", "#/terminal"],
  ] as const) {
    const button = surfaces(page).getByRole("button", { name, exact: true });
    await button.click();
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    await expect(button).toHaveAttribute("aria-current", "page");
  }

  await page.getByRole("button", { name: /Qutra Labs/ }).click();
  await expect(page).toHaveURL(/#\/overview$/);

  for (const [key, hash] of [
    ["1", "#/lab"],
    ["2", "#/tools"],
    ["3", "#/jarvis"],
    ["4", "#/terminal"],
  ] as const) {
    await page.keyboard.press(`Control+${key}`);
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
  }

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("the bar fits at 960 px in German without truncating", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 700 });
  await primePreferences(page, { locale: "de" });
  await page.goto("/#/lab");
  await waitForAppReady(page);

  const bar = page.locator("header.topbar");
  const parts = [
    bar.locator(".topbar-home"),
    bar.locator(".topbar-center"),
    bar.locator(".topbar-end"),
  ];
  const boxes = [];
  for (const part of parts) {
    const box = await part.boundingBox();
    expect(box).not.toBeNull();
    boxes.push(box!);
  }
  // Left to right, no overlap, all inside the window.
  expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x);
  expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x);
  expect(boxes[2].x + boxes[2].width).toBeLessThanOrEqual(960);

  // No control clips its own label.
  const clipped = await bar.locator("button").evaluateAll((buttons) =>
    buttons
      .filter((b) => b.scrollWidth > b.clientWidth)
      .map((b) => b.textContent),
  );
  expect(clipped).toEqual([]);
  await expect(bar).toHaveCSS("height", "44px");
});

/* The brand mark takes the theme's identity colour — the cyan Q in hud
   dark, the red Q in every other pack and every light mode, flat in high
   contrast. Both marks are in the DOM; CSS shows exactly one. */
for (const [packId, themeMode, variant, glow] of [
  ["hud", "dark", "cyan", true],
  ["hud", "light", "red", false],
  ["catppuccin", "dark", "red", true],
  ["highContrast", "dark", "red", false],
] as const) {
  test(`the brand mark is ${variant} in ${packId} / ${themeMode}`, async ({ page }) => {
    await primePreferences(page, {
      theme: "system",
      packId,
      themeMode,
      material: "none",
      highContrast: packId === "highContrast",
    });
    await page.goto("/#/overview");
    await waitForAppReady(page);

    const home = page.locator(".topbar-home");
    const shown = home.locator(`.logo-mark--${variant}`);
    const other = home.locator(`.logo-mark--${variant === "cyan" ? "red" : "cyan"}`);
    await expect(shown).toBeVisible();
    await expect(other).toBeHidden();
    await expect(shown).toHaveAttribute("src", `/brand/q-mark${variant === "cyan" ? "-cyan" : ""}.svg`);
    const filter = await shown.evaluate((el) => getComputedStyle(el).filter);
    if (glow) {
      // The glow is the variant's own colour: cyan rgb(55 214 224), red rgb(255 42 34).
      expect(filter).toContain(variant === "cyan" ? "rgba(55, 214, 224" : "rgba(255, 42, 34");
    } else {
      expect(filter).toBe("none");
    }
  });
}
