import { expect, test } from "@playwright/test";
import { openSettings, primePreferences, waitForAppReady } from "./helpers";
import type { Page } from "@playwright/test";

/* "Beni takip et": a small Qutra bubble inside the app that knows the page,
   walks through it, and outlines what a step is about. It is off until the
   user turns it on, keeps to the bottom-left, and is saved like any setting. */

const areas = (page: Page) => page.getByRole("navigation", { name: "Surfaces" });

/** Known preferences on the first load only, so a reload shows what the app saved. */
async function primeOnce(page: Page) {
  await page.addInitScript(() => {
    const key = "contextos.v1.preferences";
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(
        key,
        JSON.stringify({ locale: "en", theme: "light", density: "comfortable", onboardingDone: true }),
      );
    }
  });
}

test("turned on from the Qutra page, it guides a page, points at things and can be hidden", async ({
  page,
}) => {
  await primeOnce(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/jarvis");
  await waitForAppReady(page);

  // Off to begin with, and nothing of it on the Qutra page itself.
  await expect(page.getByTestId("companion-bubble")).toHaveCount(0);
  const follow = page.getByRole("button", { name: "Follow me" });
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await follow.click();
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("companion-bubble")).toHaveCount(0);

  // On another page it sits bottom-left, clear of the toasts at the right.
  await areas(page).getByRole("button", { name: "Home" }).click();
  const bubble = page.getByTestId("companion-bubble");
  await expect(bubble).toBeVisible();
  const box = (await bubble.boundingBox())!;
  expect(box.x).toBeLessThan(40);
  expect(box.y + box.height).toBeGreaterThan(900 - 40);

  // Its panel names the page and gives the first step.
  await bubble.click();
  const panel = page.getByTestId("companion-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("On this page: Home")).toBeVisible();
  await expect(panel.getByText("Step 1 of 4")).toBeVisible();

  // "Show me" outlines the item the step is about, without touching it.
  await panel.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("companion-step")).toContainText("Open Projects");
  await panel.getByTestId("companion-show").click();
  const projects = page.locator('[data-guide="home-workspaces"]');
  await expect(projects).toHaveAttribute("data-guide-hit", "true");
  await expect(projects).toHaveCSS("outline-style", "solid");
  await expect(page).toHaveURL(/#\/overview$/);

  // It follows the user to another page and shows that page's guide.
  await areas(page).getByRole("button", { name: "Tools", exact: true }).click();
  await expect(panel.getByText("On this page: Toolbox")).toBeVisible();

  // "Hide on this page" hides the area, and the choice survives a reload.
  await panel.getByTestId("companion-hide").click();
  await expect(page.getByTestId("companion-bubble")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show again" })).toBeVisible();
  await page.reload();
  await waitForAppReady(page);
  await expect(page.getByTestId("companion-bubble")).toHaveCount(0);
  await areas(page).getByRole("button", { name: "Home" }).click();
  await expect(page.getByTestId("companion-bubble")).toBeVisible();

  // Settings lists the hidden area and brings it back.
  const settings = await openSettings(page, "general");
  await expect(settings.getByRole("checkbox", { name: "Follow me" })).toBeChecked();
  await settings.getByRole("button", { name: "Show again on Tools" }).click();
  await expect(settings.getByRole("button", { name: "Show again on Tools" })).toHaveCount(0);
});

test("inside Settings the bubble stays usable, and Escape closes only its chat", async ({
  page,
}) => {
  await primePreferences(page, { companionEnabled: true });
  await page.goto("/#/overview");
  await waitForAppReady(page);

  const settings = await openSettings(page, "privacy");
  const bubble = settings.getByTestId("companion-bubble");
  await expect(bubble).toBeVisible();
  await bubble.click();
  const panel = settings.getByTestId("companion-panel");
  await expect(panel.getByText("On this page: Settings")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(settings).toBeVisible();
});

test("a free question that cannot be answered says why, and keeps the question", async ({
  page,
}) => {
  await primePreferences(page, { companionEnabled: true, localAssistantEnabled: true });
  await page.goto("/#/overview");
  await waitForAppReady(page);

  await page.getByTestId("companion-bubble").click();
  const panel = page.getByTestId("companion-panel");
  const box = panel.getByLabel("Ask about this page");
  await box.fill("Where do I start?");
  await box.press("Enter");

  // The browser build has no engine: the failure is said, and the question stays.
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(box).toHaveValue("Where do I start?");
});

test("the bubble's motion stops under reduced motion", async ({ page }) => {
  await primePreferences(page, { companionEnabled: true });
  await page.goto("/#/overview");
  await waitForAppReady(page);
  await expect(page.getByTestId("companion-bubble")).toHaveCSS("animation-name", "companion-in");

  await primePreferences(page, { companionEnabled: true, reduceMotion: true });
  await page.reload();
  await waitForAppReady(page);
  await expect(page.getByTestId("companion-bubble")).toHaveCSS("animation-name", "none");
});
