import { expect, test, type Page } from "@playwright/test";
import { primePreferences, waitForAppReady } from "./helpers";

/* The Jarvis page in Turkish: the history panel with folders, the title row, the
   composer's model chip and Jarvis's own settings. Each test leaves a
   screenshot in e2e/screenshots/ to look at. */

const HUD = { theme: "system", packId: "hud", themeMode: "dark", material: "none" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function message(id: string, role: "user" | "assistant", content: string, at: number) {
  return { id, role, content, createdAt: at, requestId: `r-${id}` };
}

function conversation(id: string, title: string, at: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    workspaceId: null,
    engagementId: null,
    origin: "chat",
    createdAt: at,
    updatedAt: at,
    lastOpenedAt: at - 1,
    eraseRevision: 0,
    messages: [
      message(`${id}-q`, "user", title, at),
      message(`${id}-a`, "assistant", `“${title}” için kısa bir yanıt.`, at),
    ],
    ...extra,
  };
}

/** A week of conversations, two folders, a pin, an archived one, and two
    things Jarvis remembers. The open one is "naber", as in screenshot 1. */
function seed(page: Page, { longTitle = false }: { longTitle?: boolean } = {}) {
  const now = Date.now();
  const naber = longTitle
    ? "Müşteri A için dış ağ keşfi: hangi servisler açık, hangileri riskli ve rapora ne yazmalıyım?"
    : "naber";
  const conversations = [
    { ...conversation("c-naber", naber, now - 5 * 60_000), lastOpenedAt: now },
    conversation("c-nmap", "nmap -sV çıktısını yorumla", now - 2 * HOUR),
    conversation("c-scope", "Ev laboratuvarı kapsamı", now - DAY - HOUR, { pinnedAt: now - DAY }),
    conversation("c-gitleaks", "Gitleaks raporunu okuma", now - DAY - 3 * HOUR),
    conversation("c-acme-1", "ACME web uygulaması: giriş noktaları", now - 3 * DAY, { folderId: "f-acme" }),
    conversation("c-acme-2", "ACME rapor taslağı", now - 4 * DAY, { folderId: "f-acme" }),
    conversation("c-htb", "HTB makinesi notları", now - 6 * DAY, { folderId: "f-htb" }),
    conversation("c-yara", "YARA kuralı yazımı", now - 12 * DAY),
    conversation("c-old", "Eski deneme", now - 20 * DAY, { archivedAt: now - DAY }),
  ];
  const folders = [
    { id: "f-acme", name: "Müşteri: ACME", createdAt: now - 5 * DAY, updatedAt: now - 5 * DAY },
    { id: "f-htb", name: "HackTheBox", createdAt: now - 7 * DAY, updatedAt: now - 7 * DAY },
  ];
  const memories = [
    { id: "m-1", text: "Laboratuvar ağım 10.10.0.0/24.", createdAt: now - 2 * DAY, updatedAt: now - 2 * DAY },
    { id: "m-2", text: "Raporlarımı Türkçe ve madde madde istiyorum.", createdAt: now - DAY, updatedAt: now - DAY },
  ];
  return page.addInitScript(
    ({ conversations, folders, memories }) => {
      localStorage.setItem("contextos.v1.conversations", JSON.stringify(conversations));
      localStorage.setItem("contextos.v1.conversationFolders", JSON.stringify(folders));
      localStorage.setItem("contextos.v1.jarvisMemories", JSON.stringify(memories));
    },
    { conversations, folders, memories },
  );
}

async function openJarvis(page: Page, width: number, options: { longTitle?: boolean } = {}) {
  await primePreferences(page, {
    ...HUD,
    locale: "tr",
    localAssistantEnabled: true,
    jarvisAboutYou: "Küçük şirketler için sızma testi yapıyorum.",
  });
  await seed(page, options);
  await page.setViewportSize({ width, height: 860 });
  await page.goto("/#/jarvis");
  await waitForAppReady(page);
  return page.getByTestId("jarvis-history");
}

for (const width of [1280, 1920]) {
  test(`the history panel and the title row at ${width} px`, async ({ page }) => {
    const history = await openJarvis(page, width);
    const list = history.getByRole("navigation", { name: "Sohbetler" });
    await expect(list.getByRole("heading", { name: "Sabitlenenler" })).toBeVisible();
    await expect(list.getByRole("heading", { name: "Bugün" })).toBeVisible();
    await expect(list.getByRole("button", { name: "naber", exact: true })).toHaveAttribute("aria-current", "page");
    // The title row starts where the conversation starts, beside the panel.
    const title = page.getByTestId("local-assistant-chat").getByRole("heading", { level: 2, name: "naber" });
    await expect(title).toBeVisible();
    const box = await title.boundingBox();
    const panel = await history.boundingBox();
    expect(box!.x).toBeGreaterThan(panel!.x + panel!.width + 12);
    await page.screenshot({ animations: "disabled", path: `e2e/screenshots/jarvis-history-${width}.png` });
  });
}

test("a long title keeps its room beside the header's chips", async ({ page }) => {
  await openJarvis(page, 1280, { longTitle: true });
  const title = page.getByTestId("local-assistant-chat").getByRole("heading", { level: 2 });
  const box = await title.boundingBox();
  expect(box!.width).toBeGreaterThan(200);
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-long-title-1280.png" });
});

test("folders open, count their conversations and take one by drag and drop", async ({ page }) => {
  const history = await openJarvis(page, 1440);
  const acme = history.getByRole("button", { name: /^Müşteri: ACME\s*\d+ sohbet$/ });
  await expect(acme).toHaveAccessibleName(/2 sohbet$/);
  await acme.click();
  await expect(history.getByRole("group", { name: "Müşteri: ACME" }).getByRole("button", { name: "ACME rapor taslağı", exact: true })).toBeVisible();

  // Drag "YARA kuralı yazımı" onto HackTheBox; the folder lights up on the way.
  const row = history.getByRole("button", { name: "YARA kuralı yazımı", exact: true });
  const target = history.getByRole("button", { name: /^HackTheBox\s*\d+ sohbet$/ });
  const from = (await row.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + from.height / 2 - 20, { steps: 4 });
  await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });
  await expect(history.locator(".jvh-folder.is-over")).toHaveCount(1);
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-drag-to-folder.png" });
  await page.mouse.up();
  await expect(target).toHaveAccessibleName(/2 sohbet$/);
  await expect(history.getByRole("group", { name: "HackTheBox" }).getByRole("button", { name: "YARA kuralı yazımı", exact: true })).toBeVisible();

  // The menu does the same from the keyboard, and search finds by words.
  await history.getByRole("button", { name: "nmap -sV çıktısını yorumla için işlemler" }).click();
  await page.getByRole("menuitem", { name: "Klasöre taşı" }).click();
  await expect(page.getByRole("menuitem", { name: "Müşteri: ACME" })).toBeVisible();
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-move-menu.png" });
  await page.getByRole("menuitem", { name: "Müşteri: ACME" }).click();
  await expect(acme).toHaveAccessibleName(/3 sohbet$/);

  await history.getByRole("searchbox", { name: "Sohbetlerde ara" }).fill("rapor");
  await expect(history.getByRole("heading", { name: /Sonuçlar/ })).toBeVisible();
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-search.png" });
});

test("a new folder, the archive, and hiding the panel", async ({ page }) => {
  const history = await openJarvis(page, 1440);
  await history.getByRole("button", { name: "Yeni klasör" }).click();
  await history.getByRole("textbox", { name: "Klasör adı" }).fill("Kırmızı takım");
  await history.getByRole("textbox", { name: "Klasör adı" }).press("Enter");
  await expect(history.getByRole("button", { name: /^Kırmızı takım\s*\d+ sohbet$/ })).toBeVisible();

  await history.getByRole("button", { name: /^Arşiv\s*\d+$/ }).click();
  await expect(history.getByRole("button", { name: "Eski deneme", exact: true })).toBeVisible();
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-archive.png" });
  await history.getByRole("button", { name: "Geçmişe dön" }).click();

  await page.getByRole("button", { name: "Geçmiş", exact: true }).click();
  await expect(page.getByTestId("jarvis-history")).toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-history-hidden.png" });
});

test("the composer's model chip switches this conversation's model", async ({ page }) => {
  await openJarvis(page, 1440);
  const chip = page.getByTestId("jarvis-model-chip");
  await expect(chip).toBeVisible();
  await chip.click();
  const picker = page.getByRole("dialog", { name: "Model seçin" });
  await expect(picker.getByText("Bu bilgisayarda")).toBeVisible();
  // The browser build cannot reach a local engine, and says so.
  await expect(picker.getByText("Yerel modellere şu anda ulaşılamıyor.")).toBeVisible();
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-model-chip.png" });
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
});

test("Jarvis's settings: personalization, memory, model, keys and data", async ({ page }) => {
  await openJarvis(page, 1440);
  await page.getByRole("button", { name: "Jarvis ayarları" }).click();
  const sheet = page.getByTestId("jarvis-settings");
  await expect(sheet.getByRole("heading", { name: "Kişiselleştirme" })).toBeVisible();
  await expect(sheet.getByLabel("Jarvis sizin hakkınızda neyi bilmeli?")).toHaveValue(
    "Küçük şirketler için sızma testi yapıyorum.",
  );
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-settings-personal.png" });

  await sheet.getByRole("button", { name: "Hafıza" }).click();
  await sheet.getByLabel("Jarvis'in hatırlaması gereken bir şey").fill("Hedef kapsamı her zaman yazılı onayla.");
  await sheet.getByRole("button", { name: "Ekle" }).click();
  await expect(sheet.getByText("Hedef kapsamı her zaman yazılı onayla.")).toBeVisible();
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-settings-memory.png" });

  await sheet.getByRole("button", { name: "Model", exact: true }).click();
  await expect(sheet.getByRole("heading", { name: "Model", exact: true })).toBeVisible();
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-settings-model.png" });

  await sheet.getByRole("button", { name: "Bulut anahtarları" }).click();
  await expect(sheet.getByText(/Windows Kimlik Bilgileri Yöneticisi/)).toBeVisible();
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-settings-keys.png" });

  await sheet.getByRole("button", { name: "Veri denetimleri" }).click();
  await expect(sheet.getByRole("button", { name: "Tüm sohbetleri arşivle" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: /sohbeti arşivle/ })).toBeVisible();
  await page.screenshot({ animations: "disabled", path: "e2e/screenshots/jarvis-settings-data.png" });

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});
