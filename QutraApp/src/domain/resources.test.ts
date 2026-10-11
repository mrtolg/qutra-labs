import { describe, expect, it } from "vitest";
import { windowsPathIdentity } from "./resources";

describe("windowsPathIdentity", () => {
  it("treats slash, casing and trailing separators as the same path", () => {
    expect(windowsPathIdentity(" C:/Users/Mert/Notes/ ")).toBe(
      windowsPathIdentity("c:\\users\\mert\\notes"),
    );
  });

  it("preserves a drive root identity", () => {
    expect(windowsPathIdentity("C:\\")).toBe("c:\\");
  });
});
