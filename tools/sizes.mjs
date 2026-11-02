import { readArchive, readEntry } from "./asar-lib.mjs";
const p = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar";
const { fd, header, dataOffset } = readArchive(p);
const assets = header.files.webview.files.assets.files;
for (const name of ["index-b2375c20c2a9.js","app-shared-b9a49a97ca55.js","index.client-5f0e08df5c98.js"]) {
  const e = assets[name];
  console.log(name, e ? e.size : "missing");
}
import fs from "node:fs"; fs.closeSync(fd);
