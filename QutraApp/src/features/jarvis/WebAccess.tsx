import { Globe } from "lucide-react";
import type { WebSource } from "@/domain/conversations";
import { getDb } from "@/lib/db/database";
import { createConversation, setConversationWebAccess } from "@/lib/db/conversations";
import { getBridge } from "@/lib/bridge";
import { useT } from "@/lib/i18n";

/* The "İnternet" switch of a conversation, the chip that says where the
   searches go, and the pages an answer drew on. Off by default and kept
   per conversation. Searching and reading happen in Rust (the service's own
   tools for Claude, Brave Search and the page reader for a local model);
   nothing here reaches the network. Links open through the bridge's checked
   opener, which hands http(s) addresses to the system browser. */

/** Whether a connection can have the internet at all: a local model, or
    Claude. Another service has no search tool the app uses. */
export function webAvailable(cloud: { provider: string } | null): boolean {
  return cloud === null || cloud.provider === "anthropic";
}

/** The switch in the composer. A click with no conversation yet starts one
    with the switch on, as the model chip does. */
export function WebToggle({
  conversationId,
  on,
  available,
}: {
  conversationId: string | null;
  on: boolean;
  available: boolean;
}) {
  const { t } = useT();
  const flip = () => {
    const db = getDb();
    const write = conversationId
      ? setConversationWebAccess(db, conversationId, !on)
      : createConversation(db, { webAccess: true });
    write.catch((caught: unknown) => console.error("internet switch not kept", caught));
  };
  return (
    <button
      type="button"
      className={`asst-chip asst-chip--btn asst-web${on ? " asst-web--on" : ""}`}
      aria-pressed={on}
      disabled={!available}
      title={available ? t("jarvis.web.toggleHint") : t("jarvis.web.unavailable")}
      onClick={flip}
      data-testid="assistant-web-toggle"
    >
      <Globe size={12} aria-hidden />
      {t("jarvis.web.toggle")}
    </button>
  );
}

/** The small globe chip while the switch is on: where the searches go. */
export function WebChip({ cloudName }: { cloudName: string | null }) {
  const { t } = useT();
  const text =
    cloudName === null
      ? t("jarvis.web.chipLocal")
      : t("jarvis.web.chipCloud", { name: cloudName });
  return (
    <span
      className="asst-chip asst-chip--live asst-chip--fit"
      title={text}
      data-testid="assistant-web-chip"
    >
      <Globe size={12} aria-hidden />
      <span className="asst-chip__text">{text}</span>
    </span>
  );
}

/** Only an address a browser may be sent to. */
function webAddress(source: WebSource): URL | null {
  try {
    const url = new URL(source.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Under a web-enabled answer: the pages it drew on, each one a link that
    opens in the system browser. The titles are the pages' own words and are
    shown as plain text. */
export function WebSources({ sources }: { sources: readonly WebSource[] }) {
  const { t } = useT();
  const links = sources.flatMap((source) => {
    const url = webAddress(source);
    return url ? [{ source, url }] : [];
  });
  if (links.length === 0) return null;
  return (
    <div className="asst-sources" data-testid="assistant-web-sources">
      <div className="asst-lbl">{t("jarvis.web.sources")}</div>
      <ol className="asst-sources__list">
        {links.map(({ source, url }, index) => (
          <li key={url.href}>
            <a
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
              className="asst-sources__link"
              aria-label={t("jarvis.web.sourceOpen", { title: source.title || url.hostname })}
              onClick={(event) => {
                event.preventDefault();
                void getBridge().openUrl(url.href);
              }}
            >
              <span className="asst-sources__n">{index + 1}</span>
              <span className="asst-sources__title">{source.title || url.hostname}</span>
              <span className="asst-sources__host">{url.hostname}</span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
