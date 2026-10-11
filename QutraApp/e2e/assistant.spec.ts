import { expect, test, type Page } from "@playwright/test";
import { primePreferences, waitForAppReady } from "./helpers";

/* The Assistant surface: the conversation
   is the page. A header names it, one centred column holds the turns with
   Jarvis's answer as Markdown, and the composer sits under it with a
   visible label. The conversations are the sections under the top bar. */

const HUD = { theme: "system", packId: "hud", themeMode: "dark", material: "none" };
const T = 1_759_300_000_000;

function seed(page: Page) {
  return page.addInitScript((T) => {
    localStorage.setItem(
      "contextos.v1.conversations",
      JSON.stringify([
        {
          id: "conv1",
          title: "Map what's exposed on the lab host",
          workspaceId: null,
          engagementId: null,
          origin: "chat",
          createdAt: T,
          updatedAt: T,
          lastOpenedAt: T,
          eraseRevision: 0,
          messages: [
            {
              id: "m1",
              role: "user",
              content: "Map what's exposed on the lab host 192.168.56.101 and summarise the risky services.",
              createdAt: T,
              requestId: "r1",
            },
            {
              id: "m2",
              role: "assistant",
              content: [
                "Good, that host is inside your validated scope. My plan:",
                "",
                "- Top 200 TCP ports, service and version detection",
                "- Skip host discovery (`-Pn`)",
                "",
                "Here's the exact command I'd run:",
                "",
                "```pwsh",
                "nmap -sV -Pn --top-ports 200 192.168.56.101",
                "```",
              ].join("\n"),
              createdAt: T,
              requestId: "r1",
            },
          ],
        },
      ]),
    );
  }, T);
}

test("the Assistant is one conversation: header, centred transcript, composer", async ({ page }) => {
  await primePreferences(page, { ...HUD, localAssistantEnabled: true });
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/jarvis");
  await waitForAppReady(page);

  const chat = page.getByTestId("local-assistant-chat");
  await expect(chat.getByRole("heading", { level: 2, name: "Map what's exposed on the lab host" })).toBeVisible();
  // Jarvis's answer is Markdown: a list, inline code and a code block with
  // its language and a Copy button. Nothing in it is a link or an element
  // made from the answer's own markup.
  const log = chat.getByRole("log");
  await expect(log.locator("li")).toHaveCount(2);
  await expect(log.getByText("-Pn", { exact: true })).toBeVisible();
  await expect(log.getByRole("button", { name: "Copy the pwsh code" })).toBeVisible();
  await expect(log.locator("a")).toHaveCount(0);

  // The composer has a label you can see, and the hints under it.
  await expect(chat.getByText("Message to Jarvis", { exact: true })).toBeVisible();
  await expect(chat.getByLabel("Message to Jarvis")).toBeVisible();

  // The conversations are in the history panel beside the chat.
  const sections = page.getByRole("navigation", { name: "Conversations" });
  await expect(
    sections.getByRole("button", { name: "Map what's exposed on the lab host", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: "e2e/screenshots/assistant-conversation.png" });

  // A new conversation offers things to ask instead of a greeting, and
  // choosing one fills the composer without sending it.
  await page.getByRole("button", { name: "New conversation" }).last().click();
  const prompt = chat.getByRole("button", { name: "How do I read a Gitleaks report?" });
  await expect(prompt).toBeVisible();
  await prompt.click();
  await expect(chat.getByLabel("Message to Jarvis")).toHaveValue("How do I read a Gitleaks report?");
  await page.screenshot({ path: "e2e/screenshots/assistant-new-conversation.png" });
});
