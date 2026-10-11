import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  ariaKeyshortcuts,
  assignBinding,
  bindingIndex,
  checkBinding,
  effectiveBindings,
  eventToBinding,
  isBinding,
  resetBinding,
} from "./shortcuts";
import { en as enCatalog } from "./i18n/en";
import { deferredEn } from "./i18n/deferred/en";
import { PreferencesSchema } from "@/domain/types";

// A label may live in the first-paint catalog or in the deferred words.
const en = { ...enCatalog, ...deferredEn };

const press = (key: string, code: string, mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {}) =>
  eventToBinding({
    key,
    code,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
  });

describe("shortcut registry", () => {
  it("has unique ids, labels in the catalog and no two defaults alike", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of SHORTCUTS) {
      expect(en[def.labelKey], def.id).toBeTruthy();
      if (def.defaultBinding) expect(isBinding(def.defaultBinding), def.id).toBe(true);
    }
    const defaults = SHORTCUTS.flatMap((s) => (s.defaultBinding ? [s.defaultBinding] : []));
    expect(new Set(defaults).size).toBe(defaults.length);
  });

  it("covers every area, its sections and the everyday actions", () => {
    const map = effectiveBindings({});
    expect(map["go.lab"]).toBe("Ctrl+1");
    expect(map["go.tools"]).toBe("Ctrl+2");
    expect(map["go.jarvis"]).toBe("Ctrl+3");
    expect(map["go.terminal"]).toBe("Ctrl+4");
    expect(map.palette).toBe("Ctrl+K");
    expect(map.settings).toBe("Ctrl+,");
    expect(map["terminal.newTab"]).toBe("Ctrl+Shift+T");
    expect(map["jarvis.new"]).toBe("Ctrl+Shift+O");
    expect(map["lab.new"]).toBe("Ctrl+Shift+N");
    for (const id of ["tools.view.catalog", "lab.view.findings", "go.files", "reload", "shortcuts"]) {
      expect(id in map, id).toBe(true);
    }
  });

  it("puts every default through its own rules", () => {
    const map = effectiveBindings({});
    for (const def of SHORTCUTS) {
      if (!def.defaultBinding) continue;
      const check = checkBinding(def.id, def.defaultBinding, map);
      expect(check, def.id).toEqual({ ok: true, warnings: {} });
    }
  });
});

describe("reading a key press", () => {
  it("writes modifiers in order and letters upper case", () => {
    expect(press("t", "KeyT", { ctrl: true, shift: true })).toBe("Ctrl+Shift+T");
    expect(press("k", "KeyK", { ctrl: true })).toBe("Ctrl+K");
    expect(press(",", "Comma", { ctrl: true })).toBe("Ctrl+,");
    expect(press("PageDown", "PageDown", { ctrl: true })).toBe("Ctrl+PageDown");
    expect(press("F1", "F1")).toBe("F1");
  });

  it("takes digits from their position, whatever the layout prints", () => {
    expect(press("&", "Digit1", { ctrl: true })).toBe("Ctrl+1"); // AZERTY
    expect(press("!", "Digit1", { alt: true, shift: true })).toBe("Alt+Shift+1");
  });

  it("waits while only modifiers are held", () => {
    expect(press("Control", "ControlLeft", { ctrl: true })).toBeNull();
    expect(press("Shift", "ShiftLeft", { ctrl: true, shift: true })).toBeNull();
  });

  it("names keys for aria-keyshortcuts", () => {
    expect(ariaKeyshortcuts("Ctrl+,")).toBe("Control+Comma");
    expect(ariaKeyshortcuts("Ctrl+K")).toBe("Control+K");
    expect(ariaKeyshortcuts(null)).toBeUndefined();
  });
});

describe("conflicts", () => {
  const map = effectiveBindings({});

  it("names the shortcut that already has the combination", () => {
    expect(checkBinding("go.home", "Ctrl+K", map)).toEqual({ ok: true, warnings: { takenBy: "palette" } });
  });

  it("refuses combinations Windows keeps for itself", () => {
    expect(checkBinding("palette", "Alt+F4", map)).toMatchObject({ ok: false, block: { kind: "system" } });
    expect(checkBinding("palette", "Meta+K", map)).toMatchObject({ ok: false, block: { kind: "system" } });
    expect(checkBinding("palette", "Ctrl+Alt+Delete", map)).toMatchObject({ ok: false, block: { kind: "system" } });
  });

  it("refuses a plain key, which would fire while typing", () => {
    expect(checkBinding("palette", "K", map)).toEqual({ ok: false, block: { kind: "needsModifier" } });
    expect(checkBinding("palette", "Shift+K", map)).toEqual({ ok: false, block: { kind: "needsModifier" } });
  });

  it("warns before taking editing, browser or AltGr combinations", () => {
    expect(checkBinding("palette", "Ctrl+C", map)).toEqual({
      ok: true,
      warnings: { reservedKey: "shortcuts.reserved.editing" },
    });
    expect(checkBinding("palette", "Ctrl+F", map)).toEqual({
      ok: true,
      warnings: { reservedKey: "shortcuts.reserved.find" },
    });
    expect(checkBinding("palette", "Ctrl+Alt+Q", map)).toEqual({
      ok: true,
      warnings: { reservedKey: "shortcuts.reserved.altGr" },
    });
  });
});

describe("changing bindings", () => {
  it("moves a combination and leaves the old owner without one", () => {
    const next = assignBinding({}, "go.home", "Ctrl+K");
    const map = effectiveBindings(next);
    expect(map["go.home"]).toBe("Ctrl+K");
    expect(map.palette).toBeNull();
    expect(bindingIndex(map).get("Ctrl+K")).toBe("go.home");
  });

  it("stores only changes from the defaults", () => {
    expect(assignBinding({}, "palette", "Ctrl+K")).toEqual({});
    expect(assignBinding({}, "palette", "Ctrl+Shift+P")).toEqual({ palette: "Ctrl+Shift+P" });
    expect(assignBinding({}, "palette", null)).toEqual({ palette: null });
  });

  it("resets one binding, taking its default back", () => {
    const moved = assignBinding({}, "go.home", "Ctrl+K");
    const reset = resetBinding(moved, "palette");
    const map = effectiveBindings(reset);
    expect(map.palette).toBe("Ctrl+K");
    expect(map["go.home"]).toBeNull();
  });

  it("ignores a stored binding it cannot read", () => {
    const map = effectiveBindings({ palette: "Ctrl+Ctrl+K", settings: "Shift+Ctrl+," });
    expect(map.palette).toBe("Ctrl+K");
    expect(map.settings).toBe("Ctrl+,");
  });

  it("keeps the other preferences when the stored bindings are damaged", () => {
    const prefs = PreferencesSchema.parse({ locale: "tr", packId: "catppuccin", shortcutBindings: 42 });
    expect(prefs.locale).toBe("tr");
    expect(prefs.packId).toBe("catppuccin");
    expect(prefs.shortcutBindings).toEqual({});
  });
});
