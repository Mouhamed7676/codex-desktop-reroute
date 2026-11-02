import { readArchive, readEntry } from "./asar-lib.mjs";
const p = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar";
const { fd, header, dataOffset } = readArchive(p);
const html = readEntry(fd, dataOffset, header.files.webview.files["index.html"]).toString("utf8");
console.log(html);
import fs from "node:fs"; fs.closeSync(fd);
