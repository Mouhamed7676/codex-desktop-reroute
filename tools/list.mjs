import { readArchive, walk } from "./asar-lib.mjs";
const p = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar";
const { fd, header } = readArchive(p);
const files = walk(header);
for (const f of files) {
  if (f.path.startsWith(".vite/build/")) console.log(f.path, f.entry.size);
}
console.log("=== webview/apps ===");
for (const f of files) {
  if (f.path.startsWith("webview/apps/") && f.path.split("/").length <= 4) console.log(f.path, f.entry.size);
}
console.log("=== webview root ===");
for (const f of files) {
  if (f.path.startsWith("webview/") && f.path.split("/").length === 3) console.log(f.path, f.entry.size);
}
import fs from "node:fs"; fs.closeSync(fd);
