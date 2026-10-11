import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";
import { modelLabel } from "./ModelChip";

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate("en", key, params);

describe("a model's name in the chip and its lists", () => {
  it("is readable for a known cloud id", () => {
    expect(modelLabel(t, { provider: "anthropic", model: "claude-opus-5-5" })).toBe("Claude Opus 5.5");
    expect(modelLabel(t, { provider: "openai_compat", preset: "openai", model: "gpt-4o" })).toBe("GPT-4o");
  });

  it("keeps the connection beside an id it cannot read", () => {
    expect(
      modelLabel(t, { provider: "openai_compat", preset: "groq", model: "llama-3.3-70b-versatile" }),
    ).toMatch(/llama-3\.3-70b-versatile$/);
  });

  it("leaves a local model's name alone", () => {
    expect(modelLabel(t, { provider: "local", model: "gemma4:26b" })).toBe("gemma4:26b");
  });
});
