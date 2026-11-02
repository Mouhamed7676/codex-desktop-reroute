import fs from "node:fs";
import path from "node:path";

// ASAR layout: [uint32 payload=4][uint32 headerSize][header pickle: payloadSize, jsonLength, JSON]
// File data starts at 8 + headerSize.
export function readArchive(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  const first = Buffer.alloc(8);
  fs.readSync(fd, first, 0, 8, 0);
  const headerSize = first.readUInt32LE(4);
  const headerBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, headerBuf, 0, headerSize, 8);
  const jsonLength = headerBuf.readUInt32LE(4);
  const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLength).toString("utf8"));
  return { fd, header, dataOffset: 8 + headerSize };
}

export function walk(node, prefix = "", out = []) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, full, out);
    else out.push({ path: full, entry: child });
  }
  return out;
}

export function readEntry(fd, dataOffset, entry) {
  const buf = Buffer.alloc(entry.size);
  let read = 0;
  while (read < entry.size) {
    read += fs.readSync(fd, buf, read, entry.size - read, dataOffset + Number(entry.offset) + read);
  }
  return buf;
}

export function extract(asarPath, destDir, { include = () => true, onFile } = {}) {
  const { fd, header, dataOffset } = readArchive(asarPath);
  const files = walk(header);
  let count = 0;
  for (const { path: rel, entry } of files) {
    if (!include(rel)) continue;
    const target = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readEntry(fd, dataOffset, entry));
    count++;
    onFile?.(rel, entry.size);
  }
  fs.closeSync(fd);
  return count;
}

// Minimal packer: writes a valid ASAR with the given files (paths relative to root).
export function pack(asarPath, rootDir, fileList) {
  const files = {};
  const chunks = [];
  let offset = 0;
  for (const rel of fileList) {
    const abs = path.join(rootDir, rel);
    const data = fs.readFileSync(abs);
    const parts = rel.split("/");
    let node = files;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= { files: {} };
      node = node[part].files;
    }
    node[parts.at(-1)] = { size: data.length, offset: String(offset) };
    chunks.push(data);
    offset += data.length;
  }
  const headerJson = JSON.stringify({ files });
  const jsonBuf = Buffer.from(headerJson, "utf8");
  const payloadSize = 4 + jsonBuf.length; // string length prefix + json
  const headerSize = 4 + payloadSize; // payload size field + payload
  const out = Buffer.alloc(8 + headerSize + offset);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerSize, 4);
  out.writeUInt32LE(payloadSize, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(out, 16);
  let pos = 8 + headerSize;
  for (const c of chunks) {
    c.copy(out, pos);
    pos += c.length;
  }
  fs.writeFileSync(asarPath, out);
  return { files: fileList.length, bytes: out.length };
}
