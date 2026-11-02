import { readArchive, readEntry } from "./asar-lib.mjs";

const [asarPath, entryPath, startArg, endArg] = process.argv.slice(2);
if (!asarPath || !entryPath) {
  console.error("usage: node slice-asar.mjs <asar> <entry> [start] [end]");
  process.exit(2);
}
const { fd, header, dataOffset } = readArchive(asarPath);
const parts = entryPath.split("/");
let node = header;
for (const p of parts) node = node.files?.[p];
if (!node || node.files) {
  console.error("entry not found:", entryPath);
  process.exit(1);
}
const text = readEntry(fd, dataOffset, node).toString("utf8");
const start = Math.max(0, Number(startArg ?? 0));
const end = Math.min(text.length, Number(endArg ?? start + 4000));
console.log(text.slice(start, end));
import fs from "node:fs";
fs.closeSync(fd);
