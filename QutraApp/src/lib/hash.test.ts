import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash";

describe("sha256Hex", () => {
  it("matches the empty-string digest", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes UTF-8 text stably", async () => {
    const a = await sha256Hex("packaged-smoke");
    const b = await sha256Hex("packaged-smoke");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(a).not.toBe(await sha256Hex("other"));
  });
});
