import { Fragment, useMemo, useState, type CSSProperties } from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "@/lib/i18n";

/* Jarvis's answers as Markdown. Inert by
   construction: the text is parsed here into React elements, every string
   reaches the DOM as a text node, and nothing here sets HTML, so markup in an
   answer stays visible text. Links show their address and are not
   followable: nothing in an answer can navigate, fetch or reach the app. Code
   is copied exactly as written. Loaded lazily, in its own chunk. */

const MAX_DEPTH = 6;
const MAX_INLINE_DEPTH = 6;
/** Longer answers are shown as plain text rather than parsed. */
const MAX_LENGTH = 200_000;

type Inline =
  | { k: "text"; v: string }
  | { k: "code"; v: string }
  | { k: "strong" | "em" | "del"; c: Inline[] }
  | { k: "link"; c: Inline[]; href: string }
  | { k: "br" };

type Align = "left" | "center" | "right" | undefined;

export type Block =
  | { k: "p"; c: Inline[] }
  | { k: "h"; level: number; c: Inline[] }
  | { k: "code"; lang: string; text: string }
  | { k: "list"; ordered: boolean; start: number; items: Block[][] }
  | { k: "quote"; c: Block[] }
  | { k: "hr" }
  | { k: "table"; head: Inline[][]; align: Align[]; rows: Inline[][][] };

/* ---------- Blocks ---------- */

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_DELIM = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?[ \t]*$/;

const isBlank = (line: string) => line.trim() === "";

function indentOf(line: string): number {
  let cols = 0;
  for (const ch of line) {
    if (ch === " ") cols += 1;
    else if (ch === "\t") cols += 4 - (cols % 4);
    else break;
  }
  return cols;
}

function stripIndent(line: string, cols: number): string {
  let seen = 0;
  let i = 0;
  while (i < line.length && seen < cols) {
    const ch = line[i];
    if (ch === " ") seen += 1;
    else if (ch === "\t") seen += 4 - (seen % 4);
    else break;
    i += 1;
  }
  return line.slice(i);
}

function startsBlock(line: string): boolean {
  return (
    FENCE_OPEN.test(line) ||
    HR.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line)
  );
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (ch === "\\" && row[i + 1] === "|") {
      cell += "|";
      i += 1;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines: readonly string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  return (
    head !== undefined &&
    delim !== undefined &&
    head.includes("|") &&
    TABLE_DELIM.test(delim) &&
    splitRow(head).length === splitRow(delim).length
  );
}

function sameList(m: RegExpExecArray, base: number, ordered: boolean, bullet: string): boolean {
  const marker = m[2]!;
  return (
    m[1]!.length === base && /\d/.test(marker[0]!) === ordered && marker.slice(-1) === bullet
  );
}

function parseList(lines: readonly string[], start: number, depth: number): [Block, number] {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const base = first[1]!.length;
  const ordered = /\d/.test(first[2]![0]!);
  const bullet = first[2]!.slice(-1);
  const startNumber = ordered ? Number.parseInt(first[2]!, 10) : 1;
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]!);
    if (!m || !sameList(m, base, ordered, bullet)) break;
    const content = base + m[2]!.length + 1;
    const body: string[] = [m[3] ?? ""];
    i += 1;
    while (i < lines.length) {
      const line = lines[i]!;
      if (isBlank(line)) {
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j]!)) j += 1;
        if (j < lines.length && indentOf(lines[j]!) >= content) {
          body.push("");
          i += 1;
          continue;
        }
        break;
      }
      if (indentOf(line) >= content) {
        body.push(stripIndent(line, content));
        i += 1;
        continue;
      }
      if (startsBlock(line)) break;
      // A lazy continuation of the item's paragraph.
      body.push(line.trim());
      i += 1;
    }
    items.push(
      depth < MAX_DEPTH
        ? parseBlocks(body, depth + 1)
        : [{ k: "p", c: parseInline(body.join("\n"), 0) }],
    );
    // A blank line between two items keeps the list going.
    let j = i;
    while (j < lines.length && isBlank(lines[j]!)) j += 1;
    if (j > i && j < lines.length) {
      const next = LIST_ITEM.exec(lines[j]!);
      if (next && sameList(next, base, ordered, bullet)) i = j;
    }
  }
  return [{ k: "list", ordered, start: startNumber, items }, i];
}

function parseTable(lines: readonly string[], start: number): [Block, number] {
  const head = splitRow(lines[start]!).map((cell) => parseInline(cell, 0));
  const align: Align[] = splitRow(lines[start + 1]!).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : undefined;
  });
  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) {
    const cells = splitRow(lines[i]!);
    rows.push(head.map((_, index) => parseInline(cells[index] ?? "", 0)));
    i += 1;
  }
  return [{ k: "table", head, align, rows }, i];
}

function parseBlocks(lines: readonly string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const indent = fence[1]!.length;
      const marker = fence[2]!;
      const body: string[] = [];
      i += 1;
      // An unclosed fence (a streaming answer, or a cut one) runs to the end.
      while (i < lines.length) {
        const close = FENCE_CLOSE.exec(lines[i]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
          i += 1;
          break;
        }
        body.push(stripIndent(lines[i]!, indent));
        i += 1;
      }
      out.push({ k: "code", lang: fence[3] ?? "", text: body.join("\n") });
      continue;
    }
    if (HR.test(line)) {
      out.push({ k: "hr" });
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ k: "h", level: heading[1]!.length, c: parseInline(heading[2] ?? "", 0) });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        inner.push(QUOTE.exec(lines[i]!)![1]!);
        i += 1;
      }
      out.push(
        depth < MAX_DEPTH
          ? { k: "quote", c: parseBlocks(inner, depth + 1) }
          : { k: "p", c: parseInline(inner.join("\n"), 0) },
      );
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [list, next] = parseList(lines, i, depth);
      out.push(list);
      i = next;
      continue;
    }
    if (isTableStart(lines, i)) {
      const [table, next] = parseTable(lines, i);
      out.push(table);
      i = next;
      continue;
    }
    const paragraph: string[] = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      !isBlank(lines[i]!) &&
      !startsBlock(lines[i]!) &&
      !isTableStart(lines, i)
    ) {
      paragraph.push(lines[i]!.trim());
      i += 1;
    }
    out.push({ k: "p", c: parseInline(paragraph.join("\n"), 0) });
  }
  return out;
}

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"), 0);
}

/* ---------- Inline ---------- */

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

function findRun(src: string, from: number, run: number): number {
  let k = src.indexOf("`", from);
  while (k !== -1) {
    let n = 1;
    while (src[k + n] === "`") n += 1;
    if (n === run) return k;
    k = src.indexOf("`", k + n);
  }
  return -1;
}

/** The next `delim` that can close: not after a space or a backslash. */
function closing(src: string, from: number, delim: string): number {
  let k = src.indexOf(delim, from);
  while (k !== -1) {
    const before = src[k - 1]!;
    if (k > from && !SPACE.test(before) && before !== "\\") return k;
    k = src.indexOf(delim, k + 1);
  }
  return -1;
}

function closingSingle(src: string, from: number, ch: string): number {
  for (let k = from + 1; k < src.length; k += 1) {
    if (src[k] === "\n" && src[k + 1] === "\n") return -1;
    const before = src[k - 1]!;
    if (
      src[k] === ch &&
      before !== ch &&
      src[k + 1] !== ch &&
      !SPACE.test(before) &&
      before !== "\\"
    ) {
      return k;
    }
  }
  return -1;
}

const opens = (src: string, at: number, width: number) => {
  const next = src[at + width];
  return next !== undefined && !SPACE.test(next);
};
const wordBefore = (src: string, at: number) => at > 0 && WORD.test(src[at - 1]!);
const wordAfter = (src: string, at: number) => at < src.length && WORD.test(src[at]!);

function parseLink(
  src: string,
  start: number,
): { textEnd: number; href: string; end: number } | null {
  let depth = 0;
  let k = start;
  for (; k < src.length; k += 1) {
    const ch = src[k];
    if (ch === "\\") {
      k += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    } else if (ch === "\n" && src[k + 1] === "\n") return null;
  }
  if (k >= src.length || src[k + 1] !== "(") return null;
  const close = src.indexOf(")", k + 2);
  if (close === -1) return null;
  const inside = src.slice(k + 2, close).trim();
  const href = inside.startsWith("<")
    ? inside.slice(1, inside.includes(">") ? inside.indexOf(">") : undefined)
    : (inside.split(/\s+/)[0] ?? "");
  return { textEnd: k, href, end: close + 1 };
}

function parseInline(src: string, depth: number): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      out.push({ k: "text", v: text });
      text = "";
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\" && i + 1 < src.length && PUNCT.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push({ k: "br" });
      i += 1;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (src[i + run] === "`") run += 1;
      const close = findRun(src, i + run, run);
      if (close >= 0) {
        flush();
        let code = src.slice(i + run, close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) {
          code = code.slice(1, -1);
        }
        out.push({ k: "code", v: code });
        i = close + run;
        continue;
      }
      text += "`".repeat(run);
      i += run;
      continue;
    }
    if (depth < MAX_INLINE_DEPTH) {
      if ((ch === "*" || ch === "_" || ch === "~") && src[i + 1] === ch) {
        const close = closing(src, i + 2, ch + ch);
        const intraword = ch === "_" && (wordBefore(src, i) || wordAfter(src, close + 2));
        if (close > i + 2 && opens(src, i, 2) && !intraword) {
          flush();
          out.push({
            k: ch === "~" ? "del" : "strong",
            c: parseInline(src.slice(i + 2, close), depth + 1),
          });
          i = close + 2;
          continue;
        }
      } else if (ch === "*" || ch === "_") {
        const close = closingSingle(src, i + 1, ch);
        const intraword = ch === "_" && (wordBefore(src, i) || wordAfter(src, close + 1));
        if (close > i + 1 && opens(src, i, 1) && !intraword) {
          flush();
          out.push({ k: "em", c: parseInline(src.slice(i + 1, close), depth + 1) });
          i = close + 1;
          continue;
        }
      } else if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
        const image = ch === "!";
        const open = image ? i + 1 : i;
        const link = parseLink(src, open);
        if (link) {
          flush();
          const label = src.slice(open + 1, link.textEnd);
          // An image is never fetched; its description stands in for it.
          if (image) out.push({ k: "text", v: label });
          else out.push({ k: "link", c: parseInline(label, depth + 1), href: link.href });
          i = link.end;
          continue;
        }
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

/* ---------- Rendering ---------- */

function plain(nodes: readonly Inline[]): string {
  return nodes
    .map((n) =>
      n.k === "text" || n.k === "code" ? n.v : n.k === "br" ? " " : plain(n.c),
    )
    .join("");
}

function Inlines({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.k) {
          case "text":
            return <Fragment key={index}>{node.v}</Fragment>;
          case "code":
            return (
              <code key={index} className="md-ic">
                {node.v}
              </code>
            );
          case "strong":
            return (
              <strong key={index}>
                <Inlines nodes={node.c} />
              </strong>
            );
          case "em":
            return (
              <em key={index}>
                <Inlines nodes={node.c} />
              </em>
            );
          case "del":
            return (
              <del key={index}>
                <Inlines nodes={node.c} />
              </del>
            );
          case "br":
            return <br key={index} />;
          case "link": {
            const label = plain(node.c);
            return (
              <span key={index} className="md-link">
                <Inlines nodes={node.c} />
                {node.href && node.href !== label && (
                  <span className="md-href"> ({node.href})</span>
                )}
              </span>
            );
          }
        }
      })}
    </>
  );
}

/** A copy button that says "Copied" to the eye and to a screen reader. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The text is still on screen to select by hand.
    }
  };
  return (
    <>
      <button
        type="button"
        className="btn btn--ghost btn--sm md-copy"
        aria-label={label}
        onClick={() => void copy()}
      >
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        {copied ? t("readiness.copied") : t("readiness.copy")}
      </button>
      <span className="sr-only" role="status">
        {copied ? t("readiness.copied") : ""}
      </span>
    </>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { t } = useT();
  const name = lang || t("jarvis.code.plain");
  return (
    <div className="md-code">
      <div className="md-code__h">
        <span className="md-code__lang">{name}</span>
        <CopyButton text={text} label={t("jarvis.code.copy", { lang: name })} />
      </div>
      <pre className="md-code__b">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.k) {
    case "p":
      return (
        <p>
          <Inlines nodes={block.c} />
        </p>
      );
    case "h":
      // Not a document heading: an answer must not reshape the page outline.
      return (
        <p className={`md-h md-h${Math.min(block.level, 4)}`}>
          <Inlines nodes={block.c} />
        </p>
      );
    case "code":
      return <CodeBlock lang={block.lang} text={block.text} />;
    case "hr":
      return <hr />;
    case "quote":
      return (
        <blockquote>
          <Blocks blocks={block.c} />
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, index) => {
        // A one-paragraph item is tight: its text sits in the item itself.
        const only = item.length === 1 ? item[0] : undefined;
        return (
          <li key={index}>
            {only?.k === "p" ? <Inlines nodes={only.c} /> : <Blocks blocks={item} />}
          </li>
        );
      });
      return block.ordered ? (
        <ol start={block.start === 1 ? undefined : block.start}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case "table": {
      const cellStyle = (index: number): CSSProperties | undefined =>
        block.align[index] ? { textAlign: block.align[index] } : undefined;
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index} style={cellStyle(index)}>
                    <Inlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, index) => (
                    <td key={index} style={cellStyle(index)}>
                      <Inlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
}

export default function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => (text.length > MAX_LENGTH ? null : parseMarkdown(text)), [text]);
  if (!blocks) return <p className="md-plain">{text}</p>;
  return (
    <div className="md">
      <Blocks blocks={blocks} />
    </div>
  );
}
