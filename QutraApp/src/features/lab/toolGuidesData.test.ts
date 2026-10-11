import { describe, expect, it } from "vitest";
import {
  SAFE_LAB_DATASETS,
  TOOL_CATALOG,
  TOOL_CATEGORY_LABELS,
  localizeText,
  type ToolCatalogEntry,
} from "./toolCatalog";
import {
  PRIVATE_LAB_PLAYBOOKS,
  getPrivateLabCopy,
  getToolUsageGuide,
} from "./toolGuidesData";

const findTool = (id: string): ToolCatalogEntry => {
  const tool = TOOL_CATALOG.find((item) => item.id === id);
  if (!tool) throw new Error(`Missing fixture tool: ${id}`);
  return tool;
};

describe("Private Lab copy", () => {
  it.each(["en", "tr", "de", "es", "fr", "it"] as const)(
    "provides complete navigation copy for %s",
    (locale) => {
      const copy = getPrivateLabCopy(locale);
      expect(copy.title).toBeTruthy();
      expect(copy.catalog).toBeTruthy();
      expect(copy.openGuide).toBeTruthy();
      expect(copy.openNative).toBeTruthy();
    },
  );
});

const LOCALES = ["en", "tr", "de", "es", "fr", "it"] as const;

// Fields that are spelled the same way as in English in that language.
const SAME_AS_ENGLISH: Partial<Record<(typeof LOCALES)[number], readonly string[]>> = {
  de: ["version", "format"],
  fr: ["actions", "signature", "version", "format"],
};

// Category names that are the same word in English and in that language.
const SAME_LABELS = new Set([
  "de:Web", "es:Web", "fr:Web", "it:Web",
  "de:DFIR", "es:DFIR", "fr:DFIR", "it:DFIR",
  "de:Emulation",
  "it:Reverse engineering",
]);

describe("Private Lab copy in every language", () => {
  const english = getPrivateLabCopy("en");
  const fields = Object.keys(english) as (keyof typeof english)[];

  it.each(LOCALES)("has every field in %s", (locale) => {
    const copy = getPrivateLabCopy(locale);
    expect(Object.keys(copy).sort()).toEqual([...fields].sort());
    for (const field of fields) {
      expect(copy[field], `${locale}.${field}`).toBeTruthy();
    }
  });

  it.each(["tr", "de", "es", "fr", "it"] as const)(
    "does not leave English text in %s",
    (locale) => {
      const copy = getPrivateLabCopy(locale);
      const allowed = SAME_AS_ENGLISH[locale] ?? [];
      const copied = fields.filter(
        (field) => copy[field] === english[field] && !allowed.includes(field),
      );
      expect(copied).toEqual([]);
    },
  );
});

describe("Private Lab guide text in every language", () => {
  const texts = (): { where: string; value: Record<string, string | undefined> }[] => {
    const found: { where: string; value: Record<string, string | undefined> }[] = [];
    for (const tool of TOOL_CATALOG) {
      found.push({ where: `${tool.id}.purpose`, value: tool.purpose });
      const guide = getToolUsageGuide(tool);
      found.push({ where: `${tool.id}.goal`, value: guide.goal });
      found.push({ where: `${tool.id}.boundary`, value: guide.boundary });
      for (const group of ["inputs", "steps", "expected"] as const) {
        guide[group].forEach((item, index) =>
          found.push({ where: `${tool.id}.${group}[${index}]`, value: item }),
        );
      }
    }
    for (const playbook of PRIVATE_LAB_PLAYBOOKS) {
      for (const field of ["title", "summary", "output"] as const) {
        found.push({ where: `${playbook.id}.${field}`, value: playbook[field] });
      }
    }
    for (const [category, label] of Object.entries(TOOL_CATEGORY_LABELS)) {
      found.push({ where: `category.${category}`, value: label });
    }
    return found;
  };

  it.each(LOCALES)("has every guide, playbook and catalog purpose in %s", (locale) => {
    const missing = texts()
      .filter(({ value }) => !value[locale]?.trim())
      .map(({ where }) => where);
    expect([...new Set(missing)]).toEqual([]);
  });

  it.each(["de", "es", "fr", "it"] as const)(
    "does not repeat the English sentence in %s",
    (locale) => {
      const same = texts()
        .filter(
          ({ value }) =>
            value[locale] === value.en && !SAME_LABELS.has(`${locale}:${value.en}`),
        )
        .map(({ where }) => where);
      expect([...new Set(same)]).toEqual([]);
    },
  );
});

describe("Private Lab usage guides", () => {
  it("provides a bounded starter command for standard and scoped tools", () => {
    expect(getToolUsageGuide(findTool("nmap")).command).toContain(
      "<authorized-lab-target>",
    );
    expect(getToolUsageGuide(findTool("volatility")).command).toContain(
      "<prepared-memory.raw>",
    );
  });

  it("keeps selected high-impact and concept entries guide-only", () => {
    expect(getToolUsageGuide(findTool("sqlmap")).command).toBeUndefined();
    expect(
      getToolUsageGuide(findTool("credential-concepts")).command,
    ).toBeUndefined();
  });

  it("keeps every playbook reference connected to the catalog", () => {
    const ids = new Set(TOOL_CATALOG.map((tool) => tool.id));
    for (const playbook of PRIVATE_LAB_PLAYBOOKS) {
      expect(playbook.toolIds.length).toBeGreaterThan(0);
      expect(playbook.toolIds.every((id) => ids.has(id))).toBe(true);
    }
  });
});

describe("Sample datasets", () => {
  it.each(["en", "tr", "de", "es", "fr", "it"] as const)(
    "names and describes every sample in %s",
    (locale) => {
      for (const dataset of SAFE_LAB_DATASETS) {
        for (const field of ["title", "purpose", "safety"] as const) {
          const own = dataset[field][locale];
          expect(own, `${dataset.id}.${field}`).toBeTruthy();
          // Only English text may be English: a copied title is a missed one.
          if (locale !== "en") expect(own, `${dataset.id}.${field}`).not.toBe(dataset[field].en);
        }
        expect(localizeText(dataset.format, locale), dataset.id).toBeTruthy();
      }
    },
  );

  it("leaves no English word in the Turkish titles, formats and descriptions", () => {
    const english = /(?<!\p{L})(the|and|with|for|only|prepared|synthetic|harmless|summary|metadata|fixture)(?!\p{L})/iu;
    for (const dataset of SAFE_LAB_DATASETS) {
      for (const text of [dataset.title, dataset.format, dataset.purpose, dataset.safety]) {
        expect(text.tr, dataset.id).not.toMatch(english);
      }
    }
  });
});
