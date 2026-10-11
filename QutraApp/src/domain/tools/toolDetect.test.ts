import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LAUNCHER_ITEMS, canHoldInstallation } from "./launcher";
import { launcherTiles } from "./launcherGrid";

/* The data file Rust reads to look for programs (src-tauri/src/tool_detect.rs)
   must name only programs the toolbox has a tile for. */

interface DetectFile {
  version: number;
  tools: Array<{ catalogId: string; folders: string[]; executables: string[]; subPaths?: string[] }>;
}
const file = JSON.parse(readFileSync("src/domain/tools/toolDetect.json", "utf8")) as DetectFile;

describe("tool detection table", () => {
  it("names only programs that have a tile, each once", () => {
    const tiles = new Set(launcherTiles([], []).map((t) => t.catalogId));
    const ids = file.tools.map((t) => t.catalogId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(tiles.has(id), id).toBe(true);
      const item = LAUNCHER_ITEMS.find((i) => i.catalogId === id);
      expect(canHoldInstallation(item), id).toBe(true);
    }
  });

  it("only lists programs that start from an .exe", () => {
    for (const tool of file.tools) {
      for (const name of [...tool.executables, ...(tool.subPaths ?? [])]) {
        expect(name.toLowerCase().endsWith(".exe"), name).toBe(true);
      }
    }
  });

  it("leaves out only the programs with no .exe to register", () => {
    const covered = new Set(file.tools.map((t) => t.catalogId));
    const uncovered = launcherTiles([], [])
      .map((t) => t.catalogId)
      .filter((id) => !covered.has(id))
      .sort();
    // Perl, Python and batch-file programs.
    expect(uncovered).toEqual(["metasploit", "nikto", "responder"]);
  });
});
