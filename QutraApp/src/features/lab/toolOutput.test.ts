import { describe, expect, it } from "vitest";
import { parseCsv, parseToolOutput, stripAnsi } from "./toolOutput";

const NMAP = `<?xml version="1.0" encoding="UTF-8"?>
<nmaprun scanner="nmap">
<host><status state="up"/><address addr="127.0.0.1" addrtype="ipv4"/>
<ports>
<port protocol="tcp" portid="135"><state state="open"/><service name="msrpc" product="Microsoft Windows RPC"/></port>
<port protocol="tcp" portid="445"><state state="filtered"/><service name="microsoft-ds"/></port>
</ports></host>
<runstats><finished summary="Nmap done; 1 IP address (1 host up)"/></runstats>
</nmaprun>`;

describe("reading a form run's output", () => {
  it("reads Nmap XML as hosts and ports", () => {
    const parsed = parseToolOutput("nmap-xml", NMAP);
    expect(parsed).toMatchObject({
      kind: "nmap",
      summary: "Nmap done; 1 IP address (1 host up)",
      hosts: [
        {
          address: "127.0.0.1",
          status: "up",
          ports: [
            { port: "135", protocol: "tcp", state: "open", service: "msrpc", version: "Microsoft Windows RPC" },
            { port: "445", state: "filtered", service: "microsoft-ds", version: "" },
          ],
        },
      ],
    });
  });

  it("falls back to the text when Nmap XML is cut short", () => {
    expect(parseToolOutput("nmap-xml", "<nmaprun><host>").kind).toBe("text");
  });

  it("reads CSV with quoted commas and doubled quotes, keeping the header", () => {
    expect(parseCsv('a,b\n"1,2","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["1,2", 'say "hi"'],
    ]);
    const parsed = parseToolOutput("csv", 'Path,Verified\n"C:\\x.exe","Signed"\n');
    expect(parsed).toEqual({ kind: "table", columns: ["Path", "Verified"], rows: [["C:\\x.exe", "Signed"]], total: 1 });
  });

  it("reads a JSON list of records as a table, and the first list inside an object", () => {
    expect(parseToolOutput("json", '[{"RuleID":"github-pat","File":"note.txt","StartLine":2}]')).toMatchObject({
      kind: "table",
      columns: ["RuleID", "File", "StartLine"],
      rows: [["github-pat", "note.txt", "2"]],
    });
    const die = '{"detects":[{"filetype":"PE64","values":[{"string":"Compiler: MSVC"},{"string":"Linker: Microsoft"}]}]}';
    expect(parseToolOutput("json", die)).toMatchObject({
      kind: "table",
      title: "detects",
      rows: [["PE64", "Compiler: MSVC, Linker: Microsoft"]],
    });
  });

  it("reads one record with many fields (ExifTool) as fields", () => {
    const exif = JSON.stringify([
      { SourceFile: "a.png", "File:FileType": "PNG", "PNG:ImageWidth": 1, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
    ]);
    const parsed = parseToolOutput("json", exif);
    expect(parsed.kind).toBe("pairs");
    expect(parsed.kind === "pairs" && parsed.pairs[1]).toEqual(["File:FileType", "PNG"]);
  });

  it("reads JSON lines (Docker, TruffleHog) and skips a line that is not JSON", () => {
    const parsed = parseToolOutput("jsonl", '{"ID":"a","Image":"nginx"}\nnot json\n{"ID":"b","Image":"redis"}\n');
    expect(parsed).toMatchObject({ kind: "table", columns: ["ID", "Image"], total: 2 });
  });

  it("reads capinfos lines as fields and strips colour codes", () => {
    expect(parseToolOutput("keyvalue", "File type:   Wireshark/tcpdump - pcap\nNumber of packets:   4\n")).toEqual({
      kind: "pairs",
      pairs: [
        ["File type", "Wireshark/tcpdump - pcap"],
        ["Number of packets", "4"],
      ],
    });
    expect(stripAnsi(`${String.fromCharCode(27)}[31mfailed${String.fromCharCode(27)}[0m`)).toBe("failed");
  });

  it("says empty for no output and never throws on a bad shape", () => {
    expect(parseToolOutput("json", "  \n")).toEqual({ kind: "empty" });
    expect(parseToolOutput("json", "{not json").kind).toBe("text");
    expect(parseToolOutput("lines", "a\n\nb\n")).toEqual({ kind: "lines", lines: ["a", "b"], total: 2 });
  });
});
