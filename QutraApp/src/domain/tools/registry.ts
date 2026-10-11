/* The Private Cyber Lab catalog — all 30 roadmap tools.
   `status` is honest about what each entry actually does today:
   - "builtin-working": a functional local offline tool ships in the app;
   - "builtin-planned": designed built-in that does not work yet; no list
     shows it (never a "Planlandı" row on screen);
   - "external-adapter": needs a detected, user-installed official tool; the
     host detects it and links to official install docs, never bundles it.
   `name` is the English identity the launcher composes with; what the user
   reads comes from the catalogs (`tools.item.<id>.name` / `.summary`), so
   the list never shows English in another language. */

export type ToolCategory = "local" | "network" | "web" | "code" | "dfir";
export type ToolStatus = "builtin-working" | "builtin-planned" | "external-adapter";

/** Panels the Tools page renders itself: pure functions in the page. */
export type InlinePanel = "encoding" | "hash" | "jwt" | "regex" | "entropy";

/** Panels of the app's own tools that work through Rust or need room of
    their own (src/features/tools/builtin, loaded lazily). */
export const BUILTIN_PANELS = ["metadata", "keyboard", "connections", "rdap", "tls", "http", "deps"] as const;
export type BuiltinPanel = (typeof BUILTIN_PANELS)[number];

export function isBuiltinPanel(panel: string): panel is BuiltinPanel {
  return (BUILTIN_PANELS as readonly string[]).includes(panel);
}

export interface ToolEntry {
  n: number;
  id: string;
  name: string;
  category: ToolCategory;
  status: ToolStatus;
  /** For builtin-working tools: which panel renders it. */
  panel?: InlinePanel | BuiltinPanel;
  /** For external adapters: the reviewed executable + install page. */
  executable?: string;
  installUrl?: string;
}

export const TOOL_CATALOG: ToolEntry[] = [
  // --- Local offline utilities (1–8) ---
  { n: 1, id: "cyberchef", name: "Transform workbench", category: "local", status: "builtin-working", panel: "encoding" },
  { n: 2, id: "hash", name: "Hash & integrity lab", category: "local", status: "builtin-working", panel: "hash" },
  { n: 3, id: "encoding", name: "Encoding studio", category: "local", status: "builtin-working", panel: "encoding" },
  { n: 4, id: "jwt", name: "JWT inspector", category: "local", status: "builtin-working", panel: "jwt" },
  { n: 5, id: "metadata", name: "Metadata inspector", category: "local", status: "builtin-working", panel: "metadata" },
  { n: 6, id: "regex", name: "Regex laboratory", category: "local", status: "builtin-working", panel: "regex" },
  { n: 7, id: "keyviz", name: "Keyboard-event visualizer", category: "local", status: "builtin-working", panel: "keyboard" },
  { n: 8, id: "filesig", name: "File-signature & entropy", category: "local", status: "builtin-working", panel: "entropy" },

  // --- Network security (9–16) — external adapters ---
  { n: 9, id: "nmap", name: "Nmap dashboard", category: "network", status: "external-adapter", executable: "nmap", installUrl: "https://nmap.org/download.html" },
  { n: 10, id: "tshark", name: "Wireshark / TShark PCAP", category: "network", status: "external-adapter", executable: "tshark", installUrl: "https://www.wireshark.org/download.html" },
  { n: 11, id: "conns", name: "Connection & PID monitor", category: "network", status: "builtin-working", panel: "connections" },
  { n: 12, id: "dns", name: "DNS toolkit", category: "network", status: "external-adapter", executable: "dig", installUrl: "https://www.isc.org/bind/" },
  { n: 13, id: "iplookup", name: "IP / RDAP / ASN lookup", category: "network", status: "builtin-working", panel: "rdap" },
  { n: 14, id: "tls", name: "TLS certificate inspector", category: "network", status: "builtin-working", panel: "tls" },
  { n: 15, id: "zeek", name: "Zeek log explorer", category: "network", status: "external-adapter", executable: "zeek", installUrl: "https://zeek.org/get-zeek/" },
  { n: 16, id: "suricata", name: "Suricata offline IDS", category: "network", status: "external-adapter", executable: "suricata", installUrl: "https://suricata.io/download/" },

  // --- Web security (17–22) — external adapters ---
  { n: 17, id: "zap", name: "OWASP ZAP launcher", category: "web", status: "external-adapter", executable: "zap", installUrl: "https://www.zaproxy.org/download/" },
  { n: 18, id: "burp", name: "Burp Suite organizer", category: "web", status: "external-adapter", executable: "burpsuite", installUrl: "https://portswigger.net/burp/communitydownload" },
  { n: 19, id: "httpsec", name: "HTTP security analyzer", category: "web", status: "builtin-working", panel: "http" },
  { n: 20, id: "nikto", name: "Nikto wrapper", category: "web", status: "external-adapter", executable: "nikto", installUrl: "https://github.com/sullo/nikto" },
  { n: 21, id: "nuclei", name: "Nuclei (safe profiles)", category: "web", status: "external-adapter", executable: "nuclei", installUrl: "https://github.com/projectdiscovery/nuclei" },
  { n: 22, id: "juiceshop", name: "OWASP Juice Shop", category: "web", status: "external-adapter", executable: "juiceshop", installUrl: "https://owasp.org/www-project-juice-shop/" },

  // --- Code & supply-chain (23–26) — external adapters ---
  { n: 23, id: "semgrep", name: "Semgrep SAST", category: "code", status: "external-adapter", executable: "semgrep", installUrl: "https://semgrep.dev/docs/getting-started/" },
  { n: 24, id: "gitleaks", name: "Gitleaks", category: "code", status: "external-adapter", executable: "gitleaks", installUrl: "https://github.com/gitleaks/gitleaks" },
  { n: 25, id: "trivy", name: "Trivy scanner", category: "code", status: "external-adapter", executable: "trivy", installUrl: "https://trivy.dev/latest/getting-started/installation/" },
  { n: 26, id: "depcheck", name: "Dependency & CVE center", category: "code", status: "builtin-working", panel: "deps" },

  // --- Reverse engineering & DFIR (27–30) — external adapters ---
  { n: 27, id: "ghidra", name: "Ghidra / Cutter launcher", category: "dfir", status: "external-adapter", executable: "ghidra", installUrl: "https://ghidra-sre.org/" },
  { n: 28, id: "yara", name: "YARA & DiE lab", category: "dfir", status: "external-adapter", executable: "yara", installUrl: "https://github.com/VirusTotal/yara/releases" },
  { n: 29, id: "volatility", name: "Volatility memory forensics", category: "dfir", status: "external-adapter", executable: "vol", installUrl: "https://github.com/volatilityfoundation/volatility3" },
  { n: 30, id: "sigma", name: "Sysmon & Sigma explorer", category: "dfir", status: "builtin-planned" },
];

export const TOOL_CATEGORIES: ToolCategory[] = ["local", "network", "web", "code", "dfir"];

export function toolsByCategory(cat: ToolCategory): ToolEntry[] {
  return TOOL_CATALOG.filter((t) => t.category === cat);
}

/** The built-in tools a user can open: the ones that work. */
export function workingBuiltins(): ToolEntry[] {
  return TOOL_CATALOG.filter((t) => t.status === "builtin-working");
}

export function countByStatus(): Record<ToolStatus, number> {
  const out: Record<ToolStatus, number> = {
    "builtin-working": 0,
    "builtin-planned": 0,
    "external-adapter": 0,
  };
  for (const t of TOOL_CATALOG) out[t.status]++;
  return out;
}
