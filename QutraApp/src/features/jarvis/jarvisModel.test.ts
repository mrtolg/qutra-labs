import { describe, expect, it } from "vitest";
import { PreferencesSchema } from "@/domain/types";
import { Database } from "@/lib/db/database";
import { MemoryStorageAdapter } from "@/lib/db/storage";
import { en as enCatalog } from "@/lib/i18n/en";
import { deferredEn } from "@/lib/i18n/deferred/en";
import { defaultModel, resolveModel, sameModel, setDefaultModel, targetOf } from "./jarvisModel";
import { personalBlock } from "./personal";

// The words only lazy pages read load after the first paint (src/lib/i18n/deferred).
const en = { ...enCatalog, ...deferredEn };

const prefs = (over: Record<string, unknown> = {}) => PreferencesSchema.parse(over);

describe("the model a turn uses", () => {
  it("is the default from preferences unless the conversation chose its own", () => {
    expect(defaultModel(prefs({ aiProvider: "ollama", ollamaModel: "gemma4:26b" }))).toEqual({
      provider: "local",
      model: "gemma4:26b",
      own: false,
    });
    expect(defaultModel(prefs({ aiProvider: "anthropic" }))).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    expect(
      defaultModel(prefs({ aiProvider: "openai_compat", aiOpenAiPreset: "groq", aiModels: {} })),
    ).toMatchObject({ provider: "openai_compat", preset: "groq", model: "" });

    const own = resolveModel({ provider: "local", model: "qwen2.5:7b" }, prefs({ aiProvider: "anthropic" }));
    expect(own).toEqual({ provider: "local", model: "qwen2.5:7b", own: true });
    expect(targetOf(own)).toBeNull();
    expect(targetOf({ provider: "openai_compat", preset: "gemini" })).toEqual({
      provider: "openai_compat",
      preset: "gemini",
    });
  });

  it("making a choice the default writes the preferences Settings uses", () => {
    const db = new Database(new MemoryStorageAdapter());
    setDefaultModel(db, { provider: "openai_compat", preset: "openrouter", model: "x/y" });
    expect(db.prefs.get()).toMatchObject({
      aiProvider: "openai_compat",
      aiOpenAiPreset: "openrouter",
      aiModels: { "openai_compat:openrouter": "x/y" },
    });
    setDefaultModel(db, { provider: "local", model: "gemma4:26b" });
    expect(db.prefs.get()).toMatchObject({ aiProvider: "ollama", ollamaModel: "gemma4:26b" });
    expect(sameModel(defaultModel(db.prefs.get()), { provider: "local", model: "gemma4:26b" })).toBe(true);
  });
});

const t = ((key: keyof typeof en) => en[key]) as Parameters<typeof personalBlock>[0];

describe("personalBlock", () => {
  it("is empty when there is nothing to say", () => {
    expect(personalBlock(t, prefs(), [])).toBe("");
  });

  it("holds the instructions, the style and the memory, oldest memory first", () => {
    const block = personalBlock(
      t,
      prefs({ jarvisAboutYou: "Pentester", jarvisInstructions: "Commands first", jarvisResponseStyle: "concise" }),
      [
        { text: "second", createdAt: 2 },
        { text: "first", createdAt: 1 },
      ],
    );
    expect(block.startsWith(en["jarvis.personal.block.title"])).toBe(true);
    expect(block).toContain("Pentester");
    expect(block).toContain("Commands first");
    expect(block).toContain(en["jarvis.personal.block.style.concise"]);
    expect(block.indexOf("- first")).toBeLessThan(block.indexOf("- second"));
  });

  it("leaves the memory out while memory is off", () => {
    expect(personalBlock(t, prefs({ jarvisMemoryEnabled: false }), [{ text: "x", createdAt: 1 }])).toBe("");
  });
});
