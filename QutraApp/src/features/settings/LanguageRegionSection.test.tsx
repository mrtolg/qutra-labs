import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { useUi } from "@/state/ui";
import { LanguageRegionSection } from "./LanguageRegionSection";

/* Settings › Language & region: native names with a sentence each, formats
   with examples and a live preview, and every choice on disk before the
   page says so. A write that fails ("database is locked") keeps what was. */

let storage: MemoryStorageAdapter;

beforeEach(() => {
  storage = new MemoryStorageAdapter();
  setDbForTesting(new Database(storage));
  useUi.setState({ toasts: [], liveMessage: "" });
});

afterEach(() => {
  setDbForTesting(null);
  vi.restoreAllMocks();
});

const languages = () => screen.getByRole("radiogroup", { name: "App language" });

describe("Language", () => {
  it("lists each language by its own name, with a sentence in it", () => {
    render(<LanguageRegionSection />);
    const group = languages();

    for (const name of ["English", "Türkçe", "Deutsch", "Español", "Français", "Italiano"]) {
      expect(within(group).getByRole("radio", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(within(group).getByText("İncelemeniz hazır: 3 bulgu, 2 tarama.")).toHaveAttribute(
      "lang",
      "tr",
    );
    expect(within(group).getByRole("radio", { name: /English/ })).toBeChecked();
  });

  it("saves a new language to disk, so it is still there after a reload", async () => {
    render(<LanguageRegionSection />);

    await userEvent.click(within(languages()).getByRole("radio", { name: /Türkçe/ }));

    await waitFor(() => expect(getDb().prefs.get().locale).toBe("tr"));
    expect(useUi.getState().toasts.at(-1)).toMatchObject({
      kind: "success",
      messageKey: "settings.region.languageSaved",
      params: { name: "Türkçe" },
    });
    // A fresh start reads the same storage.
    expect(new Database(storage).prefs.get().locale).toBe("tr");
  });

  it("keeps the language when the save fails, and says so", async () => {
    render(<LanguageRegionSection />);
    vi.spyOn(getDb().prefs, "setDurable").mockRejectedValueOnce(new Error("database is locked"));

    await userEvent.click(within(languages()).getByRole("radio", { name: /Deutsch/ }));

    await waitFor(() =>
      expect(useUi.getState().toasts.at(-1)?.messageKey).toBe("settings.prefsSaveFailed"),
    );
    expect(getDb().prefs.get().locale).toBe("en");
    expect(within(languages()).getByRole("radio", { name: /English/ })).toBeChecked();
  });
});

describe("Formats", () => {
  it("shows each choice with an example and applies it to the preview at once", async () => {
    render(<LanguageRegionSection />);
    const date = screen.getByLabelText("Date");
    expect(within(date).getByRole("option", { name: /^By language \(/ })).toBeInTheDocument();

    await userEvent.selectOptions(date, "ymd");

    await waitFor(() => expect(getDb().prefs.get().dateFormat).toBe("ymd"));
    expect(screen.getByTestId("region-preview")).toHaveTextContent(/\d{4}-\d{2}-\d{2}/);
    expect(new Database(storage).prefs.get().dateFormat).toBe("ymd");
    expect(useUi.getState().liveMessage).toMatch(/^Saved: \d{4}-\d{2}-\d{2}/);
  });

  it("switches the clock and the number marks", async () => {
    render(<LanguageRegionSection />);

    await userEvent.selectOptions(screen.getByLabelText("Time"), "h12");
    await userEvent.selectOptions(screen.getByLabelText("Numbers"), "comma");

    await waitFor(() => expect(getDb().prefs.get().numberFormat).toBe("comma"));
    expect(getDb().prefs.get().hourCycle).toBe("h12");
    expect(screen.getByTestId("region-preview")).toHaveTextContent("1.234");
    expect(screen.getByTestId("region-preview-clock")).toHaveTextContent(/AM|PM/);
  });

  it("uses a chosen time zone and offers the way back to the defaults", async () => {
    render(<LanguageRegionSection />);
    expect(screen.queryByRole("button", { name: "Back to the language's defaults" })).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Time zone"), "Asia/Tokyo");

    await waitFor(() => expect(getDb().prefs.get().timeZone).toBe("Asia/Tokyo"));
    expect(screen.getByTestId("region-preview")).toHaveTextContent("Asia/Tokyo");

    await userEvent.click(screen.getByRole("button", { name: "Back to the language's defaults" }));
    await waitFor(() => expect(getDb().prefs.get().timeZone).toBe("system"));
    expect(getDb().prefs.get().dateFormat).toBe("auto");
  });

  it("reads an unknown stored value as the default instead of failing", () => {
    storage.write(
      "preferences",
      JSON.stringify({ locale: "en", dateFormat: "julian", hourCycle: 7, timeZone: null }),
    );
    const db = new Database(storage);
    expect(db.prefs.get()).toMatchObject({
      locale: "en",
      dateFormat: "auto",
      hourCycle: "auto",
      timeZone: "system",
    });
  });
});
