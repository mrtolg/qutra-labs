import { describe, expect, it } from "vitest";
import { folderNameFor, reportFileName } from "./engagementFolders";

/* The dialog previews the folder before Rust makes it, so the preview must
   follow the same rules (`folder_names_are_windows_safe` in
   engagement_folders.rs pins the Rust side with the same cases). */
describe("folderNameFor", () => {
  it("matches the folder Rust makes", () => {
    expect(folderNameFor("  a/b\\c:d*e?  ")).toBe("a b c d e");
    expect(folderNameFor("name...")).toBe("name");
    expect(folderNameFor("???")).toBe("Engagement");
    expect(folderNameFor("con")).toBe("con_");
    expect(folderNameFor("Ağ taraması — iç")).toBe("Ağ taraması — iç");
    expect(folderNameFor("Home Lab: internal range")).toBe("Home Lab internal range");
  });
});

describe("reportFileName", () => {
  it("names a report by its word, day and time", () => {
    const at = new Date(2026, 9, 6, 15, 7).getTime();
    expect(reportFileName("Rapor", at)).toBe("Rapor 2026-10-06 1507.md");
    expect(reportFileName("a/b", at)).toBe("a b 2026-10-06 1507.md");
  });
});
