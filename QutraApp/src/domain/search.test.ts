import { describe, expect, it } from "vitest";
import { rankSearch, type SearchDoc } from "./search";

const docs: SearchDoc[] = [
  { id: "1", type: "task", title: "Restore retry action", updatedAt: Date.now() },
  { id: "2", type: "resource", title: "restore", updatedAt: Date.now() - 40 * 86_400_000 },
  { id: "3", type: "command", title: "Git log helper", keywords: "restore command" },
  { id: "4", type: "workspace", title: "Portfolio Refresh", favorite: true },
  { id: "5", type: "task", title: "Restore center polish", workspaceId: "wsA", updatedAt: Date.now() },
];

describe("rankSearch", () => {
  it("returns empty for empty query", () => {
    expect(rankSearch(docs, "  ")).toEqual([]);
  });

  it("ranks exact title match above prefix and substring", () => {
    const results = rankSearch(docs, "restore");
    expect(results[0].id).toBe("2"); // exact title match wins despite age
    const ids = results.map((r) => r.id);
    expect(ids).toContain("1");
    expect(ids).toContain("3");
  });

  it("boosts current workspace and favorites", () => {
    const withWs = rankSearch(docs, "restore", { currentWorkspaceId: "wsA" });
    const idx5 = withWs.findIndex((r) => r.id === "5");
    const idx1 = withWs.findIndex((r) => r.id === "1");
    expect(idx5).toBeLessThan(idx1);

    const fav = rankSearch(docs, "portfolio");
    expect(fav[0].id).toBe("4");
  });

  it("requires all terms to match (AND semantics)", () => {
    expect(rankSearch(docs, "restore zebra")).toEqual([]);
  });

  it("folds Turkish characters for matching", () => {
    const turkish: SearchDoc[] = [
      { id: "t1", type: "resource", title: "Gözden geçirme notları" },
    ];
    expect(rankSearch(turkish, "gozden")).toHaveLength(1);
    expect(rankSearch(turkish, "GÖZDEN")).toHaveLength(1);
  });

  it("folds one real query per locale", () => {
    expect(
      rankSearch([{ id: "en", type: "command", title: "Overview" }], "overview"),
    ).toHaveLength(1);
    expect(
      rankSearch([{ id: "tr", type: "command", title: "Ilık ayarlar" }], "ilik"),
    ).toHaveLength(1);
    expect(
      rankSearch([{ id: "de", type: "command", title: "Größe ändern" }], "grosse"),
    ).toHaveLength(1);
    expect(
      rankSearch([{ id: "es", type: "command", title: "Añadir herramienta" }], "anadir"),
    ).toHaveLength(1);
    expect(
      rankSearch([{ id: "fr", type: "command", title: "Arrêter le terminal" }], "arreter"),
    ).toHaveLength(1);
    expect(
      rankSearch([{ id: "it", type: "command", title: "Città di lavoro" }], "citta"),
    ).toHaveLength(1);
  });
});
