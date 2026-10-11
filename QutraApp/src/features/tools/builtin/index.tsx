import type { BuiltinPanel } from "@/domain/tools/registry";
import { ConnectionsTool } from "./ConnectionsTool";
import { DepsTool } from "./DepsTool";
import { HttpTool } from "./HttpTool";
import { KeyboardTool } from "./KeyboardTool";
import { MetadataTool } from "./MetadataTool";
import { RdapTool } from "./RdapTool";
import { TlsTool } from "./TlsTool";
import { useT } from "./i18n";
import "./builtin.css";

/* The panels of the built-in tools that work through Rust or need room of
   their own. Loaded lazily by the Tools page (one chunk for all of them),
   so none of this weighs on the first paint. */

export default function BuiltinToolPanel({ panel }: { panel: BuiltinPanel }) {
  // The panel's words load with it: wait for the reader's language rather
  // than flash English first.
  const { ready } = useT();
  if (!ready) return <span className="spin" aria-hidden />;
  switch (panel) {
    case "metadata":
      return <MetadataTool />;
    case "keyboard":
      return <KeyboardTool />;
    case "connections":
      return <ConnectionsTool />;
    case "rdap":
      return <RdapTool />;
    case "tls":
      return <TlsTool />;
    case "http":
      return <HttpTool />;
    case "deps":
      return <DepsTool />;
  }
}
