import type { OutputKind } from "@/domain/tools/toolForms";

/* A form run's output for reading, structured where a parser exists and
   raw otherwise. Every reader is total: output that is
   cut short or shaped oddly falls back to the next simpler form, down to the
   raw text, and never throws. */

export interface NmapPort {
  port: string;
  protocol: string;
  state: string;
  service: string;
  version: string;
}

export interface NmapHost {
  address: string;
  name: string;
  status: string;
  ports: NmapPort[];
}

export type ParsedOutput =
  | { kind: "nmap"; hosts: NmapHost[]; summary: string }
  | { kind: "table"; columns: string[]; rows: string[][]; total: number; title?: string }
  | { kind: "pairs"; pairs: Array<[string, string]> }
  | { kind: "lines"; lines: string[]; total: number }
  | { kind: "text"; text: string }
  | { kind: "empty" };

/** Rows and lines drawn at most; the raw view keeps everything. */
export const MAX_ROWS = 500;
const MAX_COLUMNS = 8;

/** Terminal colour codes (ESC [ … letter), which Grype and Trivy print. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const BOM = String.fromCharCode(0xfeff);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    // Detect It Easy and friends keep their findings in a list of objects
    // with a readable "string" or "name".
    const named = value
      .map((item) =>
        item && typeof item === "object"
          ? ((item as Record<string, unknown>).string ??
            (item as Record<string, unknown>).name ??
            (item as Record<string, unknown>).type)
          : item,
      )
      .filter((item) => typeof item === "string" || typeof item === "number");
    if (named.length === value.length && named.length > 0) return named.join(", ");
    return `[${value.length}]`;
  }
  return "{…}";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tableOf(items: Array<Record<string, unknown>>, title?: string): ParsedOutput {
  const columns: string[] = [];
  for (const item of items.slice(0, 20)) {
    for (const [key, value] of Object.entries(item)) {
      if (columns.length >= MAX_COLUMNS) break;
      if (!columns.includes(key) && !isRecord(value)) columns.push(key);
    }
  }
  if (columns.length === 0) return { kind: "text", text: JSON.stringify(items, null, 2) };
  const rows = items.slice(0, MAX_ROWS).map((item) => columns.map((key) => cell(item[key])));
  return { kind: "table", columns, rows, total: items.length, title };
}

function pairsOf(record: Record<string, unknown>, prefix = ""): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(record)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value) && !prefix) pairs.push(...pairsOf(value, name));
    else if (!isRecord(value)) pairs.push([name, cell(value)]);
  }
  return pairs.slice(0, MAX_ROWS);
}

const objectList = (value: unknown): value is Array<Record<string, unknown>> =>
  Array.isArray(value) && value.length > 0 && value.every(isRecord);

/** The most useful shape of a JSON value: a table of the first list of
    objects found near the top, the fields of a single object, or the text. */
export function readJson(value: unknown): ParsedOutput {
  if (objectList(value)) {
    // One object with many fields (ExifTool) reads better as fields.
    if (value.length === 1 && Object.keys(value[0]!).length > MAX_COLUMNS) {
      return { kind: "pairs", pairs: pairsOf(value[0]!) };
    }
    return tableOf(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "empty" };
    return { kind: "lines", lines: value.slice(0, MAX_ROWS).map(cell), total: value.length };
  }
  if (isRecord(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (objectList(inner)) return tableOf(inner, key);
    }
    for (const inner of Object.values(value)) {
      if (!isRecord(inner)) continue;
      for (const [key, deeper] of Object.entries(inner)) {
        if (objectList(deeper)) return tableOf(deeper, key);
      }
    }
    const pairs = pairsOf(value);
    return pairs.length > 0 ? { kind: "pairs", pairs } : { kind: "empty" };
  }
  return { kind: "text", text: String(value) };
}

/** RFC 4180 rows, quotes doubled inside quoted fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

export function readNmap(xml: string): ParsedOutput | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const run = doc.getElementsByTagName("nmaprun")[0];
  if (!run) return null;
  const hosts: NmapHost[] = [...doc.getElementsByTagName("host")].map((host) => {
    const address =
      [...host.getElementsByTagName("address")].find((a) => a.getAttribute("addrtype") !== "mac")
        ?.getAttribute("addr") ?? "";
    const name = host.getElementsByTagName("hostname")[0]?.getAttribute("name") ?? "";
    const status = host.getElementsByTagName("status")[0]?.getAttribute("state") ?? "";
    const ports = [...host.getElementsByTagName("port")].map((port) => {
      const service = port.getElementsByTagName("service")[0];
      return {
        port: port.getAttribute("portid") ?? "",
        protocol: port.getAttribute("protocol") ?? "",
        state: port.getElementsByTagName("state")[0]?.getAttribute("state") ?? "",
        service: service?.getAttribute("name") ?? "",
        version: [service?.getAttribute("product"), service?.getAttribute("version")]
          .filter(Boolean)
          .join(" "),
      };
    });
    return { address, name, status, ports };
  });
  const summary =
    doc.getElementsByTagName("finished")[0]?.getAttribute("summary") ?? "";
  return { kind: "nmap", hosts, summary };
}

/** Read `text` the way the preset's output kind says. */
export function parseToolOutput(kind: OutputKind, rawText: string): ParsedOutput {
  const raw = stripAnsi(rawText);
  const text = raw.startsWith(BOM) ? raw.slice(1) : raw;
  if (!text.trim()) return { kind: "empty" };
  try {
    switch (kind) {
      case "nmap-xml":
        return readNmap(text) ?? { kind: "text", text };
      case "json":
        return readJson(JSON.parse(text));
      case "jsonl": {
        const items = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as unknown];
            } catch {
              return [];
            }
          });
        return items.length > 0 ? readJson(items) : { kind: "text", text };
      }
      case "csv": {
        const rows = parseCsv(text);
        if (rows.length < 2) return { kind: "text", text };
        const [header, ...body] = rows;
        return {
          kind: "table",
          columns: header!,
          rows: body.slice(0, MAX_ROWS),
          total: body.length,
        };
      }
      case "keyvalue": {
        const pairs = text
          .split(/\r?\n/)
          .map((line) => /^([^:]{1,60}):\s+(.*)$/.exec(line.trim()))
          .filter((m): m is RegExpExecArray => Boolean(m))
          .map((m): [string, string] => [m[1]!.trim(), m[2]!.trim()]);
        return pairs.length > 0 ? { kind: "pairs", pairs } : { kind: "text", text };
      }
      case "lines": {
        const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
        return { kind: "lines", lines: lines.slice(0, MAX_ROWS), total: lines.length };
      }
      default:
        return { kind: "text", text };
    }
  } catch {
    return { kind: "text", text };
  }
}
