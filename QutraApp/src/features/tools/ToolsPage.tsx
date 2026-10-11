import { lazy, Suspense, useState } from "react";
import { ShieldAlert, Lock } from "lucide-react";
import { useT } from "@/lib/i18n";
import { getDb, usePreferences } from "@/lib/db/database";
import { EnablePrivateLabButton } from "@/components/EnablePrivateLabButton";
import { Field } from "@/components/ui/Field";
import { isBuiltinPanel, workingBuiltins, type ToolEntry } from "@/domain/tools/registry";
import {
  encode,
  decode,
  inspectJwt,
  testRegex,
  shannonEntropy,
  type Encoding,
} from "@/domain/tools/transforms";
import { useSearchParams } from "react-router-dom";
import { resolveToolsView } from "@/domain/workbench";
import { ToolGuidesView } from "@/features/lab/ToolGuidesView";
import "@/features/lab/lab.css";
import { ToolLauncher } from "./ToolLauncher";
import { RegisteredTools } from "./RegisteredTools";
import { BuiltInTools } from "./BuiltInTools";

/** The registry's own tools that work; one not built yet is never listed.
    External programs are the launcher's tiles. */
const BUILT_IN = workingBuiltins();

/** The app's own tools that work through Rust, in one lazy chunk. */
const BuiltinToolPanel = lazy(() => import("./builtin"));

/**
 * The Tools area (spec 2026-10-07 §5.1): `?view` picks the toolbox, the
 * registered tools or one of the guide sections; the sub-bar names them, and
 * each section's own heading sits under the area's.
 */
export default function ToolsPage() {
  const { t } = useT();
  const [params] = useSearchParams();
  const view = resolveToolsView(params.get("view"));
  if (view === "box") return <ToolBox />;
  return (
    <div className="page lab-page" data-scroll-owner="page">
      <div className="lab-view-body">
        <h1 className="sr-only">{t("nav.tools")}</h1>
        {/* The guide sections share one instance, so a tool picked in a
            playbook stays picked when its catalog entry opens. */}
        {view === "registered" ? <RegisteredTools /> : <ToolGuidesView tab={view} />}
      </div>
    </div>
  );
}

/** Araç kutusu: the program launcher and the built-in utilities. */
function ToolBox() {
  const { t } = useT();
  const prefs = usePreferences();
  // One search for the whole page: the programs and the built-in tools.
  const [query, setQuery] = useState("");

  if (!prefs.privateToolsEnabled) {
    return (
      <div className="page">
        <div className="page-header"><h1>{t("nav.tools")}</h1></div>
        <div className="page-body">
          <section className="panel">
            <div className="panel-body stack" style={{ gap: "var(--sp-4)" }}>
              <div className="flex" style={{ gap: 10 }}>
                <Lock size={26} aria-hidden style={{ color: "var(--warning)" }} />
                <div>
                  <h2 style={{ margin: 0, fontSize: "var(--fs-16)" }}>{t("tools.enableTitle")}</h2>
                  <p className="muted" style={{ fontSize: "var(--fs-13)", marginTop: 4 }}>{t("tools.enableBody")}</p>
                </div>
              </div>
              <p className="callout callout--warning" style={{ fontSize: "var(--fs-13)" }}>
                <ShieldAlert size={14} aria-hidden /> {t("tools.enableWarning")}
              </p>
              <div>
                <EnablePrivateLabButton />
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-body">
        <ToolLauncher
          query={query}
          onQueryChange={setQuery}
          actions={
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              title={t("tools.disableHint")}
              onClick={() => getDb().prefs.set({ privateToolsEnabled: false })}
            >
              {t("tools.disable")}
            </button>
          }
        />
        <BuiltInTools
          tools={BUILT_IN}
          query={query}
          renderPanel={(tool) => (tool.panel ? <ToolPanel panel={tool.panel} /> : null)}
        />
      </div>
    </div>
  );
}

function ToolPanel({ panel }: { panel: NonNullable<ToolEntry["panel"]> }) {
  if (isBuiltinPanel(panel)) {
    return (
      <Suspense fallback={<span className="spin" aria-hidden />}>
        <BuiltinToolPanel panel={panel} />
      </Suspense>
    );
  }
  switch (panel) {
    case "encoding":
      return <EncodingPanel />;
    case "jwt":
      return <JwtPanel />;
    case "regex":
      return <RegexPanel />;
    case "hash":
      return <HashPanel />;
    case "entropy":
      return <EntropyPanel />;
  }
}

function EncodingPanel() {
  const { t } = useT();
  const [input, setInput] = useState("Qutra Labs");
  const [kind, setKind] = useState<Encoding>("base64");
  const [dir, setDir] = useState<"encode" | "decode">("encode");
  let output = "";
  try {
    output = dir === "encode" ? encode(input, kind) : decode(input, kind);
  } catch {
    output = t("tools.decodeError");
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="flex" style={{ gap: 8, flexWrap: "wrap" }}>
        <Field label={t("tools.encoding")}>
          {(id) => (
            <select id={id} className="input input--sm" value={kind} onChange={(e) => setKind(e.target.value as Encoding)}>
              {["base64", "hex", "url", "rot13", "binary", "reverse"].map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          )}
        </Field>
        <Field label={t("tools.direction")}>
          {(id) => (
            <select id={id} className="input input--sm" value={dir} onChange={(e) => setDir(e.target.value as "encode" | "decode")}>
              <option value="encode">{t("tools.encode")}</option>
              <option value="decode">{t("tools.decode")}</option>
            </select>
          )}
        </Field>
      </div>
      <Field label={t("tools.input")}>
        {(id) => <textarea id={id} className="input" rows={2} value={input} onChange={(e) => setInput(e.target.value)} />}
      </Field>
      <output className="mono tool-output">{output}</output>
    </div>
  );
}

function JwtPanel() {
  const { t } = useT();
  const [token, setToken] = useState("");
  let content: React.ReactNode = null;
  if (token.trim()) {
    try {
      const j = inspectJwt(token);
      content = (
        <>
          <pre className="mono tool-output">{JSON.stringify(j.header, null, 2)}</pre>
          <pre className="mono tool-output">{JSON.stringify(j.payload, null, 2)}</pre>
          <p style={{ fontSize: "var(--fs-12)" }}>
            {j.isExpired === null ? "" : j.isExpired ? `⚠ ${t("tools.jwtExpired")}` : `✓ ${t("tools.jwtValid")}`}
            {" · "}{j.signaturePresent ? `✓ ${t("tools.jwtSig")}` : t("tools.jwtNoSig")}
          </p>
        </>
      );
    } catch {
      content = <p className="form-error">{t("tools.jwtInvalid")}</p>;
    }
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Field label={t("tools.jwtToken")}>
        {(id) => <textarea id={id} className="input mono" rows={2} value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" />}
      </Field>
      {content}
    </div>
  );
}

function RegexPanel() {
  const { t } = useT();
  const [pattern, setPattern] = useState("\\d+");
  const [flags, setFlags] = useState("");
  const [sample, setSample] = useState("order 42, id 1337");
  const res = testRegex(pattern, flags, sample);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="flex" style={{ gap: 8 }}>
        <Field label={t("tools.regexPattern")} style={{ flex: 1 }}>
          {(id) => <input id={id} className="input input--sm mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />}
        </Field>
        <Field label={t("tools.regexFlags")} style={{ width: 70 }}>
          {(id) => <input id={id} className="input input--sm mono" value={flags} onChange={(e) => setFlags(e.target.value)} placeholder="gi" />}
        </Field>
      </div>
      <Field label={t("tools.regexSample")}>
        {(id) => <textarea id={id} className="input" rows={2} value={sample} onChange={(e) => setSample(e.target.value)} />}
      </Field>
      {res.warning && <p className="callout callout--warning" style={{ fontSize: "var(--fs-12)" }}><ShieldAlert size={13} aria-hidden /> {t("tools.regexWarning")}</p>}
      {res.error ? (
        <p className="form-error">
          {t(res.error === "invalidFlags" ? "tools.regexInvalidFlags" : "tools.regexInvalidPattern")}
        </p>
      ) : (
        <p style={{ fontSize: "var(--fs-12)" }}>{t("tools.matches")}: {res.matches.length}</p>
      )}
    </div>
  );
}

function HashPanel() {
  const { t } = useT();
  const [input, setInput] = useState("");
  const [algo, setAlgo] = useState<"SHA-256" | "SHA-384" | "SHA-512">("SHA-256");
  const [digest, setDigest] = useState("");
  const run = async () => {
    const data = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest(algo, data);
    setDigest(Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join(""));
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="flex" style={{ gap: 8, alignItems: "flex-end" }}>
        <Field label={t("tools.algorithm")}>
          {(id) => (
            <select id={id} className="input input--sm" value={algo} onChange={(e) => setAlgo(e.target.value as typeof algo)}>
              {["SHA-256", "SHA-384", "SHA-512"].map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
        </Field>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => void run()}>{t("tools.run")}</button>
      </div>
      <Field label={t("tools.input")}>
        {(id) => <textarea id={id} className="input" rows={2} value={input} onChange={(e) => setInput(e.target.value)} />}
      </Field>
      {digest && <output className="mono tool-output">{digest}</output>}
    </div>
  );
}

function EntropyPanel() {
  const { t } = useT();
  const [input, setInput] = useState("");
  const bytes = new TextEncoder().encode(input);
  const h = shannonEntropy(bytes);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Field label={t("tools.input")}>
        {(id) => <textarea id={id} className="input" rows={2} value={input} onChange={(e) => setInput(e.target.value)} />}
      </Field>
      <p style={{ fontSize: "var(--fs-13)" }}>
        {t("tools.entropy")}: <strong className="mono">{h.toFixed(3)}</strong> {t("tools.bitsPerByte")}
      </p>
    </div>
  );
}
