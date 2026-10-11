import { describe, expect, it } from "vitest";
import { friendlyModelName, modelDisplayName } from "./modelNames";

describe("readable model names", () => {
  it("reads the current Claude ids", () => {
    expect(friendlyModelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(friendlyModelName("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(friendlyModelName("claude-haiku-5-5")).toBe("Claude Haiku 5.5");
    expect(friendlyModelName("claude-opus-4-8")).toBe("Claude Opus 4.8");
  });

  it("drops a dated suffix and reads the older id order", () => {
    expect(friendlyModelName("claude-sonnet-4-20250514")).toBe("Claude Sonnet 4");
    expect(friendlyModelName("claude-opus-4-1-20250805")).toBe("Claude Opus 4.1");
    expect(friendlyModelName("claude-3-5-sonnet-20241022")).toBe("Claude 3.5 Sonnet");
    expect(friendlyModelName("claude-3-opus-latest")).toBe("Claude 3 Opus");
  });

  it("reads OpenAI ids", () => {
    expect(friendlyModelName("gpt-4o")).toBe("GPT-4o");
    expect(friendlyModelName("gpt-4.1-mini")).toBe("GPT-4.1 Mini");
    expect(friendlyModelName("gpt-5")).toBe("GPT-5");
    expect(friendlyModelName("o3")).toBe("o3");
    expect(friendlyModelName("o4-mini")).toBe("o4-mini");
  });

  it("leaves an id it does not know as it is", () => {
    expect(friendlyModelName("gemma4:26b")).toBeNull();
    expect(modelDisplayName("gemma4:26b")).toBe("gemma4:26b");
    expect(modelDisplayName("llama-3.3-70b-versatile")).toBe("llama-3.3-70b-versatile");
    expect(modelDisplayName("")).toBe("");
  });

  it("prefers a real name from the service over the id", () => {
    expect(modelDisplayName("claude-opus-5-5", "Claude Opus 5.5 (preview)")).toBe(
      "Claude Opus 5.5 (preview)",
    );
    expect(modelDisplayName("claude-opus-5-5", "claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelDisplayName("claude-opus-5-5", "  ")).toBe("Claude Opus 5.5");
  });
});
