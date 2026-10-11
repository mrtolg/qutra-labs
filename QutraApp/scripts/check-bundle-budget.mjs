import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const budgetBytes = Number(process.env.CONTEXTOS_MAIN_GZIP_BUDGET ?? 200 * 1024);
const distRoot = path.resolve("dist");
const html = await readFile(path.join(distRoot, "index.html"), "utf8");
const entryMatch = html.match(
  /<script[^>]+type="module"[^>]+src="\/assets\/([^"]+\.js)"/,
);

if (!entryMatch) {
  throw new Error("Could not find the production entry script in dist/index.html");
}

const entryPath = path.join(distRoot, "assets", entryMatch[1]);
const source = await readFile(entryPath);
const gzipBytes = gzipSync(source, { level: 9 }).byteLength;
const report = {
  entry: path.relative(process.cwd(), entryPath),
  rawBytes: source.byteLength,
  gzipBytes,
  budgetBytes,
  remainingBytes: budgetBytes - gzipBytes,
};

console.log(JSON.stringify(report));
if (gzipBytes > budgetBytes) {
  throw new Error(
    `Main bundle is ${(gzipBytes / 1024).toFixed(2)} kB gzip; budget is ${(budgetBytes / 1024).toFixed(2)} kB.`,
  );
}
