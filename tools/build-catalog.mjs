#!/usr/bin/env node
// Builds a Codex model catalog that lists the models a rerouted provider
// exposes. Clones a known-good entry so every required field is present, then
// overrides only identity and limits.
//
// Usage:
//   node build-catalog.mjs <catalog.json> <out.json> [slug:display:ctx ...]
//   node build-catalog.mjs <catalog.json> <out.json> --models <ids.txt>
//
// catalog.json is the output of `codex debug models` (may carry a UTF-8 BOM).
// ids.txt is one model id per line; blank lines and #comments are skipped.

import fs from "node:fs";

const argv = process.argv.slice(2);
const modelsFileIdx = argv.indexOf("--models");
const modelsFile = modelsFileIdx >= 0 ? argv.splice(modelsFileIdx, 2)[1] : null;
const [catalogPath, outPath, ...specs] = argv;
if (!catalogPath || !outPath) {
  console.error("usage: node build-catalog.mjs <catalog.json> <out.json> [slug:display:ctx ... | --models ids.txt]");
  process.exit(2);
}

// PowerShell's Out-File -Encoding utf8 writes a BOM; JSON.parse rejects it.
const source = JSON.parse(fs.readFileSync(catalogPath, "utf8").replace(/^\uFEFF/, ""));
const template =
  source.models.find((m) => m.slug === "gpt-6-sol") ?? source.models[0];
if (!template) {
  console.error("no template model in catalog");
  process.exit(1);
}

const DEFAULT_CTX = 128_000;
// Provider-side ceiling shared by the NIM catalog; per-model overrides go in specs.
const DEFAULT_MAX_CTX = 128_000;

const entries = modelsFile
  ? fs
      .readFileSync(modelsFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((id) => [id, id])
  : specs.map((spec) => spec.split(":"));

const models = entries.length > 0
  ? entries.map(([slug, display, ctx]) => {
      const contextWindow = Number(ctx) || DEFAULT_CTX;
      return {
        ...template,
        slug,
        display_name: display ?? slug,
        description: `${display ?? slug} via rerouted upstream`,
        context_window: contextWindow,
        max_context_window: Math.max(contextWindow, DEFAULT_MAX_CTX),
        // Keep the entry selectable and non-hidden in the picker.
        visibility: "list",
        supported_in_api: true,
        // No image input on these endpoints; claiming otherwise breaks uploads.
        input_modalities: ["text"],
        supports_search_tool: false,
        use_responses_lite: false,
        supports_reasoning_effort_updates: false,
        experimental_supported_tools: [],
      };
    })
  : source.models;

fs.writeFileSync(outPath, JSON.stringify({ models }, null, 2));
console.log(`wrote ${models.length} model(s) -> ${outPath}`);
for (const m of models) console.log(`  ${m.slug}  (${m.display_name}) ctx=${m.context_window}`);
