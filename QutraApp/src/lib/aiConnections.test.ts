import { describe, expect, it } from "vitest";
import { detectKeyProvider, targetOfKeyProvider } from "./aiConnections";

describe("which service a pasted key belongs to", () => {
  it("reads the service from how the key starts", () => {
    expect(detectKeyProvider("sk-ant-api03-example")).toBe("anthropic");
    expect(detectKeyProvider("sk-proj-example-key")).toBe("openai");
    expect(detectKeyProvider("  sk-abcdefghijkl ")).toBe("openai");
    expect(detectKeyProvider("BSAexampleBraveKey123")).toBe("brave");
    expect(detectKeyProvider("  BSAexampleBraveKey123\n")).toBe("brave");
  });

  it("does not guess at anything else", () => {
    for (const other of ["", "  ", "AIzaSyExample", "gsk_example", "bsa-lowercase", "BS", "xBSAexample"]) {
      expect(detectKeyProvider(other), JSON.stringify(other)).toBeNull();
    }
  });
});

describe("the chat connection a key is used through", () => {
  it("maps the two chat services", () => {
    expect(targetOfKeyProvider("anthropic")).toEqual({ provider: "anthropic" });
    expect(targetOfKeyProvider("openai")).toEqual({ provider: "openai_compat", preset: "openai" });
  });

  it("gives a Brave Search key no chat connection", () => {
    expect(targetOfKeyProvider("brave")).toBeNull();
  });
});
