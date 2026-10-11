import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Binary,
  Braces,
  FileKey2,
  FileSearch,
  Fingerprint,
  Globe,
  Hash,
  LockKeyhole,
  Network,
  Package,
  Regex,
  Repeat,
  ShieldCheck,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/en";
import type { ToolEntry } from "@/domain/tools/registry";

/* The built-in tools: the ones that work, read from the registry, so a tool
   that starts working shows up here on its own and one that does not yet
   work is never listed. One opens at a time on the bench under the grid. */

/** An icon per known tool; a new one gets the wrench until it has its own. */
const ICONS: Record<string, LucideIcon> = {
  cyberchef: Repeat,
  hash: Hash,
  encoding: Binary,
  jwt: FileKey2,
  regex: Regex,
  filesig: Fingerprint,
  metadata: FileSearch,
  keyviz: Braces,
  conns: Network,
  iplookup: Globe,
  tls: LockKeyhole,
  httpsec: ShieldCheck,
  depcheck: Package,
};

export function BuiltInTools({
  tools,
  query,
  renderPanel,
}: {
  tools: readonly ToolEntry[];
  query: string;
  renderPanel: (tool: ToolEntry) => ReactNode;
}) {
  const { t, locale } = useT();
  const [openId, setOpenId] = useState<string | null>(null);
  const benchRef = useRef<HTMLElement>(null);
  const name = (tool: ToolEntry) => t(`tools.item.${tool.id}.name` as MessageKey);
  const summary = (tool: ToolEntry) => t(`tools.item.${tool.id}.summary` as MessageKey);
  const needle = query.trim().toLocaleLowerCase(locale);
  const shown = tools.filter(
    (tool) =>
      !needle ||
      name(tool).toLocaleLowerCase(locale).includes(needle) ||
      summary(tool).toLocaleLowerCase(locale).includes(needle),
  );
  const open = tools.find((tool) => tool.id === openId) ?? null;

  useEffect(() => {
    if (openId) benchRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [openId]);

  return (
    <section className="tbx-section tbx-builtins" aria-labelledby="tbx-builtins">
      <h2 id="tbx-builtins" className="tbx-section__title">
        {t("launcher.builtInTitle")} <span>{tools.length}</span>
      </h2>
      <p className="tbx-section__lead">{t("launcher.builtInLead")}</p>
      {shown.length === 0 ? (
        <p className="tbx-section__empty">{t("launcher.builtInNoMatch", { query: query.trim() })}</p>
      ) : (
        <ul className="tbx-builtin-grid">
          {shown.map((tool) => {
            const Icon = ICONS[tool.id] ?? Wrench;
            const isOpen = tool.id === openId;
            return (
              <li key={tool.id}>
                <button
                  type="button"
                  className="tbx-builtin"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? "tbx-bench" : undefined}
                  data-testid="builtin-tool"
                  onClick={() => setOpenId(isOpen ? null : tool.id)}
                >
                  <span className="tbx-builtin__icon" aria-hidden>
                    <Icon size={16} />
                  </span>
                  <span className="tbx-builtin__text">
                    <strong>{name(tool)}</strong>
                    <span>{summary(tool)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open && (
        <section
          id="tbx-bench"
          ref={benchRef}
          className="tbx-bench"
          aria-label={name(open)}
          data-testid="builtin-bench"
        >
          <header className="tbx-bench__head">
            <h3>{name(open)}</h3>
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              aria-label={`${t("action.close")}: ${name(open)}`}
              onClick={() => setOpenId(null)}
            >
              <X size={14} aria-hidden />
            </button>
          </header>
          <div className="tbx-bench__body">{renderPanel(open)}</div>
        </section>
      )}
    </section>
  );
}
