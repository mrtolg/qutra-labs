import { beforeEach, describe, expect, it } from "vitest";
import { Database, getDb, setDbForTesting } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import {
  companionVisibleOn,
  hideCompanionOn,
  setCompanionEnabled,
  showCompanionOn,
} from "./preferences";

/* "Beni takip et" and "hide on this page" are ordinary preferences: they
   survive a restart, and the bubble is off until the user turns it on. */

let adapter: MemoryStorageAdapter;

beforeEach(() => {
  adapter = new MemoryStorageAdapter();
  setDbForTesting(new Database(adapter));
});

/** A restart: a database opened over what the first one stored. */
const restart = () => setDbForTesting(new Database(adapter));

describe("the companion switch", () => {
  it("is off until it is turned on", () => {
    expect(getDb().prefs.get().companionEnabled).toBe(false);
    expect(companionVisibleOn(getDb().prefs.get(), "overview")).toBe(false);
  });

  it("stays on after a restart, and off again after turning it off", () => {
    setCompanionEnabled(true);
    restart();
    expect(getDb().prefs.get().companionEnabled).toBe(true);
    expect(companionVisibleOn(getDb().prefs.get(), "lab.runs")).toBe(true);

    setCompanionEnabled(false);
    restart();
    expect(getDb().prefs.get().companionEnabled).toBe(false);
  });

  it("is never drawn on the Qutra page, which has the full chat", () => {
    setCompanionEnabled(true);
    expect(companionVisibleOn(getDb().prefs.get(), "assistant")).toBe(false);
  });
});

describe("hide on this page", () => {
  it("hides one area's pages and keeps the others", () => {
    setCompanionEnabled(true);
    const key = hideCompanionOn("lab.runs");
    expect(key).toBe("lab");
    const prefs = getDb().prefs.get();
    expect(companionVisibleOn(prefs, "lab.findings")).toBe(false);
    expect(companionVisibleOn(prefs, "lab.list")).toBe(false);
    expect(companionVisibleOn(prefs, "tools.box")).toBe(true);
    expect(companionVisibleOn(prefs, "overview")).toBe(true);
  });

  it("is remembered after a restart, once per area", () => {
    setCompanionEnabled(true);
    hideCompanionOn("tools.catalog");
    hideCompanionOn("tools.box");
    restart();
    expect(getDb().prefs.get().companionHidden).toEqual(["tools"]);
    expect(companionVisibleOn(getDb().prefs.get(), "tools.datasets")).toBe(false);
  });

  it("comes back with 'show again'", () => {
    setCompanionEnabled(true);
    const key = hideCompanionOn("terminal");
    showCompanionOn(key);
    restart();
    expect(getDb().prefs.get().companionHidden).toEqual([]);
    expect(companionVisibleOn(getDb().prefs.get(), "terminal")).toBe(true);
  });

  it("is not lost when the switch goes off and on", () => {
    setCompanionEnabled(true);
    hideCompanionOn("files");
    setCompanionEnabled(false);
    setCompanionEnabled(true);
    expect(companionVisibleOn(getDb().prefs.get(), "files")).toBe(false);
  });
});
