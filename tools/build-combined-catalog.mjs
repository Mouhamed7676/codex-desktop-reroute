#!/usr/bin/env node
// Builds a combined model catalog: NVIDIA NIM models + OpenCode Zen models.
// Output: catalogs/combined.json — one catalog the Codex picker can render,
// listing both lanes side by side.
//
// Zen free models are listed with a note that the Zen free tier currently
// requires the real opencode client's shape (env block + builtin tool names),
// which the bridge injects on every Zen-routed turn.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const nvidiaPath = path.join(root, "catalogs", "nvidia.json");
const outPath = path.join(root, "catalogs", "combined.json");

const nvidia = JSON.parse(fs.readFileSync(nvidiaPath, "utf8"));

const ZEN_MODELS = [
  { slug: "big-pickle", display: "Big Pickle (Zen free)", note: "OpenCode Zen — free tier" },
  { slug: "beam-free", display: "Beam Free (Zen free)", note: "OpenCode Zen — free tier" },
  { slug: "flint-40b-free", display: "Flint 40B Free (Zen free)", note: "OpenCode Zen — free tier" },
  { slug: "mimo-v2.6-flash-free", display: "Mimo v2.6 Flash Free (Zen free)", note: "OpenCode Zen — free tier" },
  { slug: "nemotron-3.5-super-vl-free", display: "Nemotron 3.5 Super VL Free (Zen free)", note: "OpenCode Zen — free tier" },
  { slug: "nemotron-3.5-lightning-free", display: "Nemotron 3.5 Lightning Free (Zen free)", note: "OpenCode Zen — free tier" },
  { slug: "deepseek-v4.1-flash-free", display: "DeepSeek v4.1 Flash Free (Zen free)", note: "OpenCode Zen — free tier" },
  { slug: "glm-5.3-flash-free", display: "GLM 5.3 Flash Free (Zen free)", note: "OpenCode Zen — free tier" },
  { slug: "pulse-alpha-free", display: "Pulse Alpha Free (Zen free)", note: "OpenCode Zen — free tier" },
];

const REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
  { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
];

function zenEntry(m) {
  return {
    slug: m.slug,
    display_name: m.display,
    description: `${m.note}. Routes through the OpenCode Zen bridge at https://opencode.ai/inference/openai/v1.`,
    default_reasoning_level: "medium",
    supported_reasoning_levels: REASONING_LEVELS,
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 10, // sort after NVIDIA entries
    additional_speed_tiers: ["fast"],
    service_tiers: [{ id: "priority", name: "Free", description: "OpenCode Zen free tier" }],
    default_service_tier: "priority",
    availability_nux: null,
    upgrade: null,
    model_messages: {
      persistent_instructions: "",
      instructions_template: "You are a helpful coding assistant running via OpenCode Zen.",
      instructions_variables: null,
      approvals: { on_request: null, never: null, unless_trusted: null },
    },
    _zen: true, // internal marker for the launcher to build per-model routing
    _zen_note: m.note,
  };
}

const combined = {
  models: [
    ...nvidia.models.map((m) => ({ ...m, _zen: false })),
    ...ZEN_MODELS.map(zenEntry),
  ],
};

fs.writeFileSync(outPath, JSON.stringify(combined, null, 2) + "\n");
console.log(
  `wrote ${outPath}: ${nvidia.models.length} NVIDIA + ${ZEN_MODELS.length} Zen = ${combined.models.length} models`,
);
