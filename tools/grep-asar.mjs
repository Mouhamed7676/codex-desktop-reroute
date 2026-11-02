import { readArchive, walk, readEntry } from "./asar-lib.mjs";

const [asarPath, pattern, include = "", max = "40", ctx = "90"] = process.argv.slice(2);
if (!asarPath || !pattern) {
  console.error("usage: node grep-asar.mjs <asar> <regex> [include-substring] [max] [context]");
  process.exit(2);
}
const re = new RegExp(pattern, "g");
const maxHits = Number(max);
const context = Number(ctx);
const { fd, header, dataOffset } = readArchive(asarPath);
const files = walk(header).filter((f) => include === "" || f.path.includes(include));
let hits = 0;
for (const { path, entry } of files) {
  if (hits >= maxHits) break;
  if (entry.size > 64 * 1024 * 1024) continue;
  const text = readEntry(fd, dataOffset, entry).toString("utf8");
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null && hits < maxHits) {
    hits++;
    const start = Math.max(0, m.index - context);
    const end = Math.min(text.length, m.index + m[0].length + context);
    const snippet = text.slice(start, end).replace(/\s+/g, " ");
    console.log(`\n[${hits}] ${path} @${m.index}\n  ...${snippet}...`);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}
console.log(`\n-- ${hits} hits --`);
import fs from "node:fs";
fs.closeSync(fd);
