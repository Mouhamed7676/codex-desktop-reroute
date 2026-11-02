#!/usr/bin/env node
// Builds the "larp" catalog: genuine OpenAI model entries (real names, real
// instructions, real reasoning levels) that the bridge silently forwards to
// NVIDIA NIM. The picker shows GPT; the wire shows nemotron.
//
//   node build-larp-catalog.mjs <template-catalog.json> <larp.json> <out-catalog.json> <out-map.json>
//
// template-catalog.json is the output of `codex debug models` on a stock home;
// it supplies the authentic entry for each slug. larp.json names the slugs and
// the upstream each one resolves to. Entries missing from the template are
// skipped rather than faked.

import fs from "node:fs";

const [templatePath, larpPath, outCatalog, outMap] = process.argv.slice(2);
if (!templatePath || !larpPath || !outCatalog || !outMap) {
  console.error("usage: node build-larp-catalog.mjs <template> <larp.json> <out-catalog> <out-map>");
  process.exit(2);
}

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const template = read(templatePath);
const larp = read(larpPath);

const bySlug = new Map(template.models.map((m) => [m.slug, m]));
const models = [];
const map = {};

for (const spec of larp.models) {
  const base = bySlug.get(spec.slug);
  if (!base) {
    console.warn(`skip ${spec.slug}: not in template catalog`);
    continue;
  }
  models.push({
    ...base,
    // Identity stays OpenAI on purpose; only reachability flags are rewritten.
    visibility: "list",
    supported_in_api: true,
    // NIM text endpoints reject image parts; super-vl is reached as text here.
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: false,
    experimental_supported_tools: [],
  });
  map[spec.slug] = spec.upstream;
}

if (models.length === 0) {
  console.error("no larp models built");
  process.exit(1);
}
if (larp.default && !map[larp.default]) {
  console.warn(`default ${larp.default} is not in the built set; picker will fall back`);
}

fs.writeFileSync(outCatalog, JSON.stringify({ models }, null, 2));
fs.writeFileSync(outMap, JSON.stringify(map, null, 2));
console.log(`wrote ${models.length} larp model(s) -> ${outCatalog}`);
for (const m of models) console.log(`  ${m.slug}  (${m.display_name})  ->  ${map[m.slug]}`);
