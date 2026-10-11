import { describe, expect, it } from "vitest";
import { toolFormsEn } from "@/lib/i18n/toolForms/en";
import {
  TOOL_FORMS,
  checkValue,
  formFor,
  formProblems,
  inputFields,
  isFixture,
  previewTokens,
  quoteToken,
  usedFields,
  type FormField,
} from "./toolForms";

const at = (path: string) => ({ canonicalPath: path, displayName: path.split("\\").pop()! });
const form = (id: string) => TOOL_FORMS.find((item) => item.id === id)!;
const preset = (formId: string, presetId: string) =>
  form(formId).presets.find((item) => item.id === presetId)!;

describe("tool forms data", () => {
  it("has a form for every listed tool, and at least twelve", () => {
    const ids = TOOL_FORMS.map((item) => item.id);
    for (const id of [
      "nmap", "tshark", "capinfos", "editcap", "mergecap", "text2pcap", "yara", "exiftool",
      "strings", "sigcheck", "autoruns", "gitleaks", "trivy", "grype", "syft", "die",
      "chainsaw", "volatility", "ghidra", "docker", "jq",
    ]) {
      expect(ids).toContain(id);
    }
    expect(ids.length).toBeGreaterThanOrEqual(12);
  });

  it("gives every form, preset and field its words in the forms' copy", () => {
    const keys = new Set(Object.keys(toolFormsEn));
    for (const item of TOOL_FORMS) {
      expect(keys.has(`toolForms.${item.id}.purpose`), item.id).toBe(true);
      for (const p of item.presets) {
        expect(keys.has(`toolForms.${item.id}.${p.id}.label`), `${item.id}.${p.id}`).toBe(true);
        expect(keys.has(`toolForms.${item.id}.${p.id}.summary`), `${item.id}.${p.id}`).toBe(true);
        for (const id of usedFields(p)) {
          expect(item.fields.some((field) => field.id === id), `${item.id}.${p.id}.${id}`).toBe(true);
        }
      }
      for (const field of item.fields.filter((f) => f.type !== "folder" && f.type !== "output")) {
        expect(keys.has(`toolForms.field.${field.id}`), field.id).toBe(true);
        expect(keys.has(`toolForms.help.${field.id}`), field.id).toBe(true);
      }
    }
  });
});

describe("matching a registered program to its form", () => {
  it("goes by the executable's file name, in any case and through a verbatim prefix", () => {
    expect(formFor(at("C:\\Program Files (x86)\\Nmap\\nmap.exe"))?.id).toBe("nmap");
    expect(formFor(at("\\\\?\\C:\\Tools\\YARA64.EXE"))?.id).toBe("yara");
    expect(formFor(at("C:\\WinGet\\sigcheck64.exe"))?.id).toBe("sigcheck");
    expect(formFor(at("C:\\Tools\\PE-bear.exe"))).toBeUndefined();
  });

  it("never takes a renamed program for a known tool by its display name", () => {
    expect(formFor({ canonicalPath: "C:\\x\\evil.exe" })).toBeUndefined();
  });

  it("knows the test fixture by its file or its name", () => {
    expect(isFixture(at("C:\\ctxb\\fixtures\\contextos-fixture.exe"))).toBe(true);
    expect(isFixture({ canonicalPath: "C:\\x\\a.exe", displayName: "ContextOS Fixture" })).toBe(true);
    expect(isFixture(at("C:\\Tools\\nmap.exe"))).toBe(false);
  });
});

describe("checking values as Rust does", () => {
  const field = (changes: Partial<FormField>): FormField => ({ id: "x", type: "text", ...changes });

  it("refuses a value that could pass for a flag or carries a control character", () => {
    expect(checkValue(field({ type: "target" }), "-iL")).toBe("invalid");
    expect(checkValue(field({ type: "text" }), "--script=x")).toBe("invalid");
    expect(checkValue(field({ type: "text" }), "a\u0007b")).toBe("invalid");
  });

  it("checks targets, ports and numbers by shape", () => {
    const target = field({ type: "target" });
    expect(checkValue(target, "10.0.0.0/24")).toBeNull();
    expect(checkValue(target, "scanme.example.org")).toBeNull();
    expect(checkValue(target, "a b")).toBe("invalid");
    const ports = field({ type: "ports" });
    expect(checkValue(ports, "22,80,8000-8100")).toBeNull();
    for (const bad of ["0", "65536", "80-22", "1,,2"]) expect(checkValue(ports, bad)).toBe("invalid");
    const n = field({ type: "int", min: 3, max: 64 });
    expect(checkValue(n, "6")).toBeNull();
    expect(checkValue(n, "2")).toBe("invalid");
  });

  it("takes the default when a field is left empty and names a missing one", () => {
    expect(checkValue(field({ type: "int", default: "6" }), "")).toBeNull();
    expect(checkValue(field({ type: "file" }), "")).toBe("required");
    expect(formProblems(form("strings"), preset("strings", "all"), {})).toEqual({ file: "required" });
  });

  it("asks only for what the preset uses; the folder and the output are Rust's", () => {
    expect(inputFields(form("nmap"), preset("nmap", "quick")).map((f) => f.id)).toEqual(["target"]);
    expect(inputFields(form("editcap"), preset("editcap", "range")).map((f) => f.id)).toEqual([
      "file",
      "range",
    ]);
    expect(inputFields(form("grype"), preset("grype", "folder"))).toEqual([]);
  });
});

describe("the command preview", () => {
  it("fills in values, names files and labels the folder and the output", () => {
    const names = { file: (id: string) => (id === "f1" ? "capture.pcap" : id), folder: "‹files›", output: "‹out›" };
    expect(previewTokens(form("nmap"), preset("nmap", "ports"), { target: "127.0.0.1" }, names)).toEqual([
      "-n", "-sT", "-T4", "-p", "22,80,443,3389,8080", "-oX", "-", "127.0.0.1",
    ]);
    expect(
      previewTokens(form("editcap"), preset("editcap", "range"), { file: "f1" }, names),
    ).toEqual(["-F", "pcapng", "-r", "capture.pcap", "‹out›", "1-100"]);
    expect(previewTokens(form("grype"), preset("grype", "folder"), {}, names)[0]).toBe("dir:‹files›");
    expect(previewTokens(form("nmap"), preset("nmap", "quick"), {}, names).at(-1)).toBe("‹target›");
  });

  it("quotes only what needs quoting", () => {
    expect(quoteToken("127.0.0.1")).toBe("127.0.0.1");
    expect(quoteToken("http || dns")).toBe('"http || dns"');
    expect(quoteToken("")).toBe('""');
  });
});
