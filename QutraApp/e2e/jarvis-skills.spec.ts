import { expect, test } from "@playwright/test";
import { loadDemo, primePreferences, waitForAppReady } from "./helpers";

/* The composer's skills: shipped, picked for the next message, removable,
   and the context switch stays reachable without a "0 items" label. */

test.describe("jarvis skills", () => {
  test("pick a skill, see its chip, take it off", async ({ page }) => {
    await primePreferences(page, { locale: "en", localAssistantEnabled: true });
    await loadDemo(page);
    await page.goto("/#/jarvis");

    const picker = page.getByTestId("skill-picker");
    await picker.getByText("Skills").click();
    await expect(picker.getByRole("button")).toHaveCount(8);
    await picker.getByRole("button", { name: /Extract IOCs/ }).click();

    const chip = page.getByTestId("skill-chip");
    await expect(chip).toContainText("Skill: Extract IOCs");
    await chip.getByRole("button", { name: "Remove skill Extract IOCs" }).click();
    await expect(chip).toHaveCount(0);
  });

  test("is named in Turkish", async ({ page }) => {
    await primePreferences(page, { locale: "tr", localAssistantEnabled: true });
    await page.goto("/#/jarvis");
    await waitForAppReady(page);

    const picker = page.getByTestId("skill-picker");
    await expect(picker).toContainText("Yetenekler");
    await picker.getByText("Yetenekler").click();
    await expect(picker.getByRole("button", { name: /Bulgu yaz/ })).toBeVisible();
    await expect(picker.getByRole("button", { name: /IOC çıkar/ })).toBeVisible();
  });

  test("the context switch is still reachable", async ({ page }) => {
    await primePreferences(page, { locale: "en", localAssistantEnabled: true });
    await loadDemo(page);
    await page.goto("/#/jarvis");

    await page.getByTestId("qutra-context").locator("summary").click();
    await expect(page.getByTestId("qutra-context-toggle")).toBeVisible();
  });
});
