#!/usr/bin/env node
// Imports an existing Codex home's chat history into the rerouted private home.
//
//   node import-history.mjs <sourceHome> <destHome> [--dry-run]
//
// What moves:
//   - state_5.sqlite        threads, projects, sections, receipts, spawn edges
//   - thread_history_1.sqlite  turns + items + projection cursors
//   - sessions/**/*.jsonl   rollout files (paths rewritten into destHome)
//   - session_index.jsonl   merged, deduped by thread id
//   - attachments/**        copied as-is
//
// Source databases are snapshotted with VACUUM INTO first, so a running Codex
// on the source side cannot hand us a torn read. Rows are merged with INSERT OR
// IGNORE: existing dest threads win, nothing is deleted.
//
// Every imported thread is rewritten to model_provider = "bridge" so resuming
// an old chat sends its next turn through the local adapter instead of OpenAI.
// The session_meta line inside each rollout gets the same rewrite, because
// resume reads the provider from there too.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [sourceHome, destHome, ...flags] = process.argv.slice(2);
if (!sourceHome || !destHome) {
  console.error("usage: node import-history.mjs <sourceHome> <destHome> [--dry-run]");
  process.exit(2);
}
const dryRun = flags.includes("--dry-run");
const BRIDGE_PROVIDER = "bridge";

const SNAP_DIR = path.join(destHome, ".tmp", "import-snapshot");
const DB_PAIRS = [
  {
    name: "state_5.sqlite",
    order: ["projects", "project_roots", "thread_sections", "threads"],
  },
  {
    name: "thread_history_1.sqlite",
    order: ["thread_history_projection_state", "thread_turns", "thread_items", "thread_realtime_items"],
  },
];
// Migration bookkeeping belongs to the binary that created it, not to the data.
const SKIP_TABLES = new Set(["_sqlx_migrations", "sqlite_sequence"]);

function snapshot(dbPath, outPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${outPath.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

function tables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .filter((n) => !SKIP_TABLES.has(n));
}

function columns(db, table, schema = "main") {
  // Table-valued pragma: schema-qualified PRAGMA table_info("src.t") is parsed
  // as a table literally named "src.t" and silently returns nothing.
  return db
    .prepare("SELECT name FROM pragma_table_info(?, ?)")
    .all(table, schema)
    .map((r) => r.name);
}

function mergeDb(snapPath, destPath, preferredOrder) {
  const dest = new DatabaseSync(destPath);
  const stats = {};
  try {
    dest.exec("PRAGMA foreign_keys = OFF");
    dest.exec(`ATTACH DATABASE '${snapPath.replaceAll("'", "''")}' AS src`);
    const src = new DatabaseSync(snapPath, { readOnly: true });
    let srcTables;
    try {
      srcTables = tables(src);
    } finally {
      src.close();
    }
    const ordered = [
      ...preferredOrder.filter((t) => srcTables.includes(t)),
      ...srcTables.filter((t) => !preferredOrder.includes(t)).sort(),
    ];
    for (const table of ordered) {
      // Only columns both sides share; a schema drift should drop fields, not fail the import.
      const srcCols = columns(dest, table, "src");
      const destCols = new Set(columns(dest, table, "main"));
      const shared = srcCols.filter((c) => destCols.has(c));
      if (shared.length === 0) continue;
      const colList = shared.map((c) => `"${c}"`).join(", ");
      const before = dest.prepare(`SELECT count(*) n FROM main."${table}"`).get().n;
      if (!dryRun) {
        dest.exec(
          `INSERT OR IGNORE INTO main."${table}" (${colList}) SELECT ${colList} FROM src."${table}"`,
        );
      }
      const after = dest.prepare(`SELECT count(*) n FROM main."${table}"`).get().n;
      stats[table] = after - before;
    }
    dest.exec("DETACH DATABASE src");
    dest.exec("PRAGMA foreign_keys = ON");
  } finally {
    dest.close();
  }
  return stats;
}

function rewriteRollout(srcFile, destFile) {
  const lines = fs.readFileSync(srcFile, "utf8").split("\n");
  let touched = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue; // A truncated tail line is not worth failing the import over.
    }
    if (obj.type !== "session_meta" || !obj.payload) continue;
    obj.payload.model_provider = BRIDGE_PROVIDER;
    lines[i] = JSON.stringify(obj);
    touched++;
    break;
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, lines.join("\n"));
  return touched;
}

function copyTree(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) n += copyTree(from, to);
    else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      n++;
    }
  }
  return n;
}

fs.mkdirSync(SNAP_DIR, { recursive: true });

const sourceState = path.join(sourceHome, "state_5.sqlite");
const sourceHistory = path.join(sourceHome, "thread_history_1.sqlite");
for (const p of [sourceState, sourceHistory]) {
  if (!fs.existsSync(p)) {
    console.error(`missing source db: ${p}`);
    process.exit(1);
  }
}

const report = { merged: {}, sessions: 0, attachments: 0, indexPath: null };
for (const pair of DB_PAIRS) {
  const snap = path.join(SNAP_DIR, pair.name);
  fs.rmSync(snap, { force: true });
  snapshot(path.join(sourceHome, pair.name), snap);
  report.merged[pair.name] = mergeDb(snap, path.join(destHome, pair.name), pair.order);
}

// Rollouts: copy into the private home and remap each thread's rollout_path.
const srcSessions = path.join(sourceHome, "sessions");
const destSessions = path.join(destHome, "sessions");
const remap = new Map();
if (fs.existsSync(srcSessions)) {
  for (const entry of fs.readdirSync(srcSessions, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    // .jsonl is live; .zst is an older compressed rollout kept for completeness.
    if (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".zst")) continue;
    const srcFile = path.join(entry.parentPath ?? entry.path, entry.name);
    const rel = path.relative(srcSessions, srcFile);
    const destFile = path.join(destSessions, rel);
    if (!dryRun) {
      if (entry.name.endsWith(".jsonl")) rewriteRollout(srcFile, destFile);
      else {
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(srcFile, destFile);
      }
    }
    remap.set(srcFile.toLowerCase(), destFile);
    remap.set(entry.name.toLowerCase(), destFile);
    report.sessions++;
  }
}

// Point imported threads at the copied rollouts, and route them through the bridge.
if (!dryRun) {
  const dest = new DatabaseSync(path.join(destHome, "state_5.sqlite"));
  try {
    const rows = dest.prepare("SELECT id, rollout_path FROM threads").all();
    const update = dest.prepare("UPDATE threads SET rollout_path = ?, model_provider = ? WHERE id = ?");
    dest.exec("BEGIN");
    for (const row of rows) {
      const raw = String(row.rollout_path);
      // Source rows carry a \\?\ prefix, so an exact path match misses them.
      const base = path.basename(raw).toLowerCase();
      // Old rollouts live compressed as <name>.jsonl.zst; the DB still stores the
      // plain .jsonl path and core resolves the .zst sibling itself.
      const mapped =
        remap.get(raw.toLowerCase()) ??
        remap.get(base) ??
        remap.get(`${base}.zst`);
      if (!mapped) continue;
      update.run(mapped, BRIDGE_PROVIDER, row.id);
    }
    dest.exec("COMMIT");
  } finally {
    dest.close();
  }
}

// session_index.jsonl: merge by id, keep the newer updated_at.
const srcIndex = path.join(sourceHome, "session_index.jsonl");
const destIndex = path.join(destHome, "session_index.jsonl");
if (fs.existsSync(srcIndex)) {
  const byId = new Map();
  for (const file of [destIndex, srcIndex]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj.id) continue;
      const prev = byId.get(obj.id);
      if (!prev || String(obj.updated_at ?? "") > String(prev.updated_at ?? "")) byId.set(obj.id, obj);
    }
  }
  if (!dryRun) {
    const out = [...byId.values()].map((o) => JSON.stringify(o)).join("\n") + "\n";
    fs.writeFileSync(destIndex, out);
  }
  report.indexPath = destIndex;
  report.indexEntries = byId.size;
}

report.attachments = dryRun
  ? fs.existsSync(path.join(sourceHome, "attachments"))
    ? fs.readdirSync(path.join(sourceHome, "attachments"), { recursive: true }).length
    : 0
  : copyTree(path.join(sourceHome, "attachments"), path.join(destHome, "attachments"));

console.log(JSON.stringify({ dryRun, ...report }, null, 2));
