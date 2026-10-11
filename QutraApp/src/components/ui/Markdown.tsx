import { Fragment, type ReactNode } from "react";

/* ============================================================
   Minimal, XSS-safe Markdown renderer.
   Builds React elements directly (no innerHTML), so external
   content can never inject markup. Supports: headings, bold,
   italic, inline code, code fences, lists, links, [[wikilinks]].
   ============================================================ */

interface MarkdownProps {
  source: string;
  onWikiLink?: (title: string) => void;
}

function renderInline(text: string, onWikiLink?: (t: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: code first so other syntax inside code is preserved.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[\[[^\]]+\]\])|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>")]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) {
      out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[[")) {
      const title = token.slice(2, -2);
      out.push(
        onWikiLink ? (
          <button
            key={key++}
            type="button"
            className="md-wikilink"
            onClick={() => onWikiLink(title)}
          >
            {title}
          </button>
        ) : (
          <span key={key++} className="md-wikilink">{title}</span>
        ),
      );
    } else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]"));
      const href = m[6];
      out.push(
        <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    } else {
      out.push(
        <a key={key++} href={token} target="_blank" rel="noopener noreferrer">
          {token}
        </a>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, onWikiLink }: MarkdownProps) {
  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre key={key++} className="md-pre">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2], onWikiLink);
      blocks.push(
        level === 1 ? (
          <h2 key={key++}>{content}</h2>
        ) : level === 2 ? (
          <h3 key={key++}>{content}</h3>
        ) : (
          <h4 key={key++}>{content}</h4>
        ),
      );
      i++;
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "");
        items.push(<li key={items.length}>{renderInline(itemText, onWikiLink)}</li>);
        i++;
      }
      blocks.push(
        ordered ? (
          <ol key={key++}>{items}</ol>
        ) : (
          <ul key={key++}>{items}</ul>
        ),
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // paragraph: gather consecutive non-empty lines
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    // A "#" line that is not a heading ("#", "#tag") stops the gather at
    // once. Take it as text so the loop always advances.
    if (para.length === 0) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {renderInline(p, onWikiLink)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="md">{blocks}</div>;
}
