#!/usr/bin/env node
// Responses API -> Chat Completions bridge.
// Codex only speaks wire_api = "responses". Providers that only expose
// /chat/completions (NVIDIA NIM, most OpenAI-compatible hosts) get this shim.
//
// Env:
//   PORT                 listen port                (default 8787)
//   HOST                 bind address               (default 127.0.0.1)
//   UPSTREAM_BASE_URL    chat-completions base      (default NVIDIA NIM)
//   UPSTREAM_API_KEY     bearer for upstream        (default NVIDIA_API_KEY)
//   UPSTREAM_MODEL_MAP   JSON map of requested->upstream model ids
//   UPSTREAM_TIMEOUT_MS  per-attempt timeout        (default 300000)
//   UPSTREAM_RETRIES     attempts on 429/5xx/network (default 3)

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY ?? process.env.NVIDIA_API_KEY ?? "";
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 300_000);
const UPSTREAM_RETRIES = Number(process.env.UPSTREAM_RETRIES ?? 3);
const MODEL_MAP = parseJsonEnv("UPSTREAM_MODEL_MAP", {});

// Retry backoff base. 429s from free tiers clear in seconds; 5xx usually faster.
const BACKOFF_BASE_MS = 750;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const DELTA_CHUNK_CHARS = 48;

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`[adapter] ${name} is not valid JSON; ignoring`);
    return fallback;
  }
}

function log(...args) {
  console.log(new Date().toISOString(), "[adapter]", ...args);
}

// ---------------------------------------------------------------------------
// Request translation: Responses input -> Chat Completions messages
// ---------------------------------------------------------------------------

function partText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.output_text === "string") return part.output_text;
  if (part.type === "input_image") return ""; // chat models here are text-only
  return "";
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(partText).join("");
}

export function inputToMessages(body) {
  const messages = [];
  const instructions = body.instructions ?? body.instructions_text;
  if (typeof instructions === "string" && instructions.trim() !== "") {
    messages.push({ role: "system", content: instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "function_call") {
      const call = {
        id: item.call_id ?? item.id ?? `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: {
          name: item.name ?? "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      };
      // Consecutive function calls belong to one assistant turn in chat format.
      const prev = messages.at(-1);
      if (prev && prev.role === "assistant" && Array.isArray(prev.tool_calls)) {
        prev.tool_calls.push(call);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
      }
      continue;
    }

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id ?? item.id ?? "",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }

    if (item.type === "reasoning") continue;

    if (item.role) {
      const role = item.role === "developer" ? "system" : item.role;
      const text = contentToText(item.content);
      if (text !== "") messages.push({ role, content: text });
    }
  }
  return messages;
}

export function toolsToChat(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type !== "function" && typeof tool.name !== "string") continue;
    const name = tool.name ?? tool.function?.name;
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: tool.description ?? tool.function?.description ?? "",
        parameters: tool.parameters ?? tool.function?.parameters ?? { type: "object", properties: {} },
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

export function toolChoiceToChat(choice) {
  if (choice == null) return undefined;
  if (typeof choice === "string") return choice;
  if (choice.type === "function") {
    const name = choice.name ?? choice.function?.name;
    return name ? { type: "function", function: { name } } : undefined;
  }
  return undefined;
}

export function buildChatRequest(body) {
  const requested = body.model ?? "default";
  // Wildcard lets one config survive whatever model id the client's picker sends.
  const model = MODEL_MAP[requested] ?? MODEL_MAP["*"] ?? requested;
  const chat = {
    model,
    messages: inputToMessages(body),
    stream: true, // ask upstream to stream tokens so the client sees them type out
  };
  const tools = toolsToChat(body.tools);
  if (tools) {
    chat.tools = tools;
    const choice = toolChoiceToChat(body.tool_choice);
    if (choice !== undefined) chat.tool_choice = choice;
    if (typeof body.parallel_tool_calls === "boolean") chat.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  return chat;
}

// ---------------------------------------------------------------------------
// Upstream call
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callUpstream(chatRequest, signal) {
  let lastError;
  for (let attempt = 1; attempt <= UPSTREAM_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${UPSTREAM_API_KEY}`,
        },
        body: JSON.stringify(chatRequest),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`upstream returned non-JSON: ${text.slice(0, 300)}`);
        }
      }
      lastError = new Error(`upstream ${res.status}: ${text.slice(0, 500)}`);
      // Only 429 and 5xx are worth another attempt.
      if (res.status !== 429 && res.status < 500) throw lastError;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (attempt < UPSTREAM_RETRIES) await sleep(BACKOFF_BASE_MS * attempt);
  }
  throw lastError ?? new Error("upstream failed");
}

// ---------------------------------------------------------------------------
// Response translation: Chat Completions -> Responses output items
// ---------------------------------------------------------------------------

const id = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

// Some models answer with XML tool syntax in the text channel instead of using
// native tool_calls (Nemotron does this when a tool schema is freeform).
// Recover those into real function_call items so the client's loop keeps going.
const XML_CALL_RE = /<function\.([A-Za-z0-9_]+)>([\s\S]*?)<\/function\.\1>/g;
const XML_ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
const XML_PARAM_RE = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
const COMMENTARY_RE = /<commentary>([\s\S]*?)<\/commentary>/g;

export function extractXmlToolCalls(text) {
  const calls = [];
  XML_CALL_RE.lastIndex = 0;
  let match;
  while ((match = XML_CALL_RE.exec(text)) !== null) {
    const name = match[1];
    const body = match[2];
    const args = {};
    XML_ARG_RE.lastIndex = 0;
    let arg;
    while ((arg = XML_ARG_RE.exec(body)) !== null) {
      args[arg[1].trim()] = arg[2];
    }
    XML_PARAM_RE.lastIndex = 0;
    let param;
    while ((param = XML_PARAM_RE.exec(body)) !== null) {
      args[param[1]] = param[2];
    }
    calls.push({ name, arguments: JSON.stringify(args) });
  }
  return calls;
}

export function stripXmlToolSyntax(text) {
  return text
    .replace(XML_CALL_RE, "")
    .replace(COMMENTARY_RE, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chatToOutputItems(chatResponse) {
  const choice = chatResponse.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const items = [];

  let text = typeof message.content === "string" ? message.content : contentToText(message.content);
  // Reasoning-tuned models emit the whole turn in reasoning_content and leave
  // content null when they run out of budget. A blank turn breaks the client's
  // loop, so fall back rather than ship nothing.
  if (text === "" && typeof message.reasoning_content === "string") {
    text = message.reasoning_content;
  }

  const nativeCalls = (message.tool_calls ?? []).filter((call) => call?.type === "function");
  let recovered = [];
  if (nativeCalls.length === 0 && text.includes("<function.")) {
    recovered = extractXmlToolCalls(text);
    if (recovered.length > 0) text = stripXmlToolSyntax(text);
  }

  if (text !== "") {
    items.push({
      type: "message",
      id: id("msg"),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
    });
  }

  for (const call of nativeCalls) {
    items.push({
      type: "function_call",
      id: id("fc"),
      status: "completed",
      call_id: call.id ?? id("call"),
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    });
  }

  for (const call of recovered) {
    items.push({
      type: "function_call",
      id: id("fc"),
      status: "completed",
      call_id: id("call"),
      name: call.name,
      arguments: call.arguments,
    });
  }

  // Codex treats an empty turn as an error; keep a placeholder so the turn closes.
  if (items.length === 0) {
    items.push({
      type: "message",
      id: id("msg"),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [], logprobs: [] }],
    });
  }
  return items;
}

function buildResponseObject(body, items, usage, status = "completed") {
  return {
    id: id("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: body.model ?? null,
    output: items,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: body.reasoning ?? null,
    store: false,
    temperature: body.temperature ?? null,
    text: body.text ?? null,
    tool_choice: body.tool_choice ?? "auto",
    tools: body.tools ?? [],
    top_p: body.top_p ?? null,
    truncation: body.truncation ?? null,
    usage,
    metadata: body.metadata ?? {},
  };
}

function usageFrom(chatResponse) {
  const u = chatResponse.usage ?? {};
  const input = u.prompt_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: u.total_tokens ?? input + output,
  };
}

// ---------------------------------------------------------------------------
// SSE writer
// ---------------------------------------------------------------------------

function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function send(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length > 0 ? chunks : [""];
}

function emitItem(res, item, outputIndex) {
  if (item.type === "message") {
    const empty = { ...item, status: "in_progress", content: [] };
    send(res, "response.output_item.added", { output_index: outputIndex, item: empty });
    send(res, "response.content_part.added", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    const text = item.content[0]?.text ?? "";
    for (const delta of chunkText(text, DELTA_CHUNK_CHARS)) {
      if (delta === "") continue;
      send(res, "response.output_text.delta", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        delta,
        logprobs: [],
      });
    }
    send(res, "response.output_text.done", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      text,
      logprobs: [],
    });
    send(res, "response.content_part.done", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text, annotations: [], logprobs: [] },
    });
    send(res, "response.output_item.done", { output_index: outputIndex, item });
    return;
  }

  if (item.type === "function_call") {
    send(res, "response.output_item.added", {
      output_index: outputIndex,
      item: { ...item, status: "in_progress", arguments: "" },
    });
    send(res, "response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: outputIndex,
      delta: item.arguments,
    });
    send(res, "response.function_call_arguments.done", {
      item_id: item.id,
      output_index: outputIndex,
      arguments: item.arguments,
    });
    send(res, "response.output_item.done", { output_index: outputIndex, item });
    return;
  }

  send(res, "response.output_item.done", { output_index: outputIndex, item });
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function errorPayload(message, type = "upstream_error") {
  return { error: { type, message, code: null, param: null } };
}

// ---------------------------------------------------------------------------
// Streaming path: read upstream SSE chunks and forward them to the client as
// Responses-API SSE events, token by token. Handles both text deltas and
// tool_call deltas so skills/tools keep working while streaming.
// ---------------------------------------------------------------------------

async function handleResponsesStreaming(body, chatRequest, signal, res) {
  sseHead(res);

  const responseId = id("resp");
  const messageItemId = id("msg");
  const outputIndex = 0;

  const pending = buildResponseObject(
    body,
    [],
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    "in_progress",
  );
  pending.id = responseId;
  send(res, "response.created", { response: pending });
  send(res, "response.in_progress", { response: pending });

  // Always open a message item so the client has somewhere to render text.
  send(res, "response.output_item.added", {
    output_index: outputIndex,
    item: {
      id: messageItemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  });
  send(res, "response.content_part.added", {
    item_id: messageItemId,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });

  // Track tool calls by upstream index so we can emit added/delta/done per call.
  const toolCalls = new Map(); // index -> { id, name, arguments, itemId }
  let toolOutputIndex = outputIndex + 1;

  const upstreamRequest = { ...chatRequest, stream: true };
  let accumulated = "";

  let reader;
  try {
    const resUp = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
      },
      body: JSON.stringify(upstreamRequest),
      signal,
    });
    if (!resUp.ok) {
      const text = await resUp.text();
      throw new Error(`upstream ${resUp.status}: ${text.slice(0, 500)}`);
    }
    if (!resUp.body) throw new Error("upstream returned no body");
    reader = resUp.body.getReader();
  } catch (err) {
    throw err;
  }

  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done) break;

      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        let dataLine = null;
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) dataLine = line.slice(6);
        }

        if (dataLine === "[DONE]") {
          break;
        }
        if (!dataLine) continue;

        try {
          const chunk = JSON.parse(dataLine);
          const choice = chunk.choices?.[0];
          if (!choice) continue;

          // Text delta.
          const delta = choice?.delta?.content;
          if (typeof delta === "string" && delta !== "") {
            accumulated += delta;
            send(res, "response.output_text.delta", {
              item_id: messageItemId,
              output_index: outputIndex,
              content_index: 0,
              delta,
              logprobs: [],
            });
          }

          // Tool call deltas (OpenAI-compatible streaming format).
          const tcDeltas = choice?.delta?.tool_calls;
          if (Array.isArray(tcDeltas)) {
            for (const tc of tcDeltas) {
              const index = tc.index ?? 0;
              let call = toolCalls.get(index);
              if (!call) {
                call = {
                  id: tc.id ?? id("call"),
                  name: tc.function?.name ?? "",
                  arguments: "",
                  itemId: id("fc"),
                };
                toolCalls.set(index, call);
                send(res, "response.output_item.added", {
                  output_index: toolOutputIndex,
                  item: {
                    id: call.itemId,
                    type: "function_call",
                    status: "in_progress",
                    call_id: call.id,
                    name: call.name,
                    arguments: "",
                  },
                });
                toolOutputIndex++;
              }
              const argDelta = tc.function?.arguments ?? "";
              if (argDelta !== "") {
                call.arguments += argDelta;
                send(res, "response.function_call_arguments.delta", {
                  item_id: call.itemId,
                  output_index: toolOutputIndex - 1,
                  delta: argDelta,
                });
              }
            }
          }
        } catch {
          // ignore unparseable upstream frames
        }
      }

      if (buf.includes("[DONE]")) break;
    }
  } finally {
    reader.releaseLock();
  }

  // Close out the message item.
  send(res, "response.output_text.done", {
    item_id: messageItemId,
    output_index: outputIndex,
    content_index: 0,
    text: accumulated,
    logprobs: [],
  });
  send(res, "response.content_part.done", {
    item_id: messageItemId,
    output_index: outputIndex,
    content_index: 0,
    part: {
      type: "output_text",
      text: accumulated,
      annotations: [],
      logprobs: [],
    },
  });
  send(res, "response.output_item.done", {
    output_index: outputIndex,
    item: {
      id: messageItemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: accumulated, annotations: [], logprobs: [] }],
    },
  });

  // Close out each tool call item.
  for (const [, call] of toolCalls) {
    send(res, "response.function_call_arguments.done", {
      item_id: call.itemId,
      output_index: call.itemId === messageItemId ? outputIndex : undefined,
      arguments: call.arguments,
    });
    send(res, "response.output_item.done", {
      output_index: call.itemId === messageItemId ? outputIndex : undefined,
      item: {
        id: call.itemId,
        type: "function_call",
        status: "completed",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      },
    });
  }

  // XML tool-call recovery: Nemotron sometimes emits <function.exec> in the text
  // channel instead of native tool_calls. Recover those so the client's loop
  // keeps going when no native tool calls arrived.
  const items = [];
  items.push({
    id: messageItemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: accumulated, annotations: [], logprobs: [] }],
  });
  let recovered = [];
  if (toolCalls.size === 0 && accumulated.includes("<function.")) {
    recovered = extractXmlToolCalls(accumulated);
    const stripped = stripXmlToolSyntax(accumulated);
    if (recovered.length > 0) {
      // Replace the message text with the stripped version.
      items[0].content[0].text = stripped;
      send(res, "response.output_text.done", {
        item_id: messageItemId,
        output_index: outputIndex,
        content_index: 0,
        text: stripped,
        logprobs: [],
      });
      send(res, "response.content_part.done", {
        item_id: messageItemId,
        output_index: outputIndex,
        content_index: 0,
        part: {
          type: "output_text",
          text: stripped,
          annotations: [],
          logprobs: [],
        },
      });
    }
  }
  for (const call of recovered) {
    const itemId = id("fc");
    items.push({
      id: itemId,
      type: "function_call",
      status: "completed",
      call_id: id("call"),
      name: call.name,
      arguments: call.arguments,
    });
    send(res, "response.output_item.added", {
      output_index: toolOutputIndex,
      item: {
        id: itemId,
        type: "function_call",
        status: "completed",
        call_id: id("call"),
        name: call.name,
        arguments: call.arguments,
      },
    });
    send(res, "response.function_call_arguments.delta", {
      item_id: itemId,
      output_index: toolOutputIndex,
      delta: call.arguments,
    });
    send(res, "response.function_call_arguments.done", {
      item_id: itemId,
      output_index: toolOutputIndex,
      arguments: call.arguments,
    });
    send(res, "response.output_item.done", {
      output_index: toolOutputIndex,
      item: {
        id: itemId,
        type: "function_call",
        status: "completed",
        call_id: id("call"),
        name: call.name,
        arguments: call.arguments,
      },
    });
    toolOutputIndex++;
  }

  // Codex treats an empty turn as an error; keep a placeholder so the turn closes.
  if (items.length === 0 && toolCalls.size === 0) {
    items.push({
      id: messageItemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [], logprobs: [] }],
    });
  }

  const completed = buildResponseObject(
    body,
    items,
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    "completed",
  );
  completed.id = responseId;
  send(res, "response.completed", { response: completed });
  res.write("data: [DONE]\n\n");
  res.end();
}

// Buffered path for non-streaming clients.
async function handleResponsesBuffered(body, chatRequest, signal, res) {
  let chatResponse;
  try {
    chatResponse = await callUpstream(chatRequest, signal);
  } catch (err) {
    log("upstream failed:", err.message);
    throw err;
  }

  const items = chatToOutputItems(chatResponse);
  const usage = usageFrom(chatResponse);
  log(`ok model=${chatRequest.model} items=${items.length} tokens=${usage.total_tokens}`);
  json(res, 200, buildResponseObject(body, items, usage));
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

async function handleResponses(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    json(res, 400, errorPayload(`invalid request body: ${err.message}`, "invalid_request_error"));
    return;
  }

  const wantsStream = body.stream !== false;
  const chatRequest = buildChatRequest(body);
  if (chatRequest.messages.length === 0) {
    json(res, 400, errorPayload("no input messages after translation", "invalid_request_error"));
    return;
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    if (wantsStream) {
      await handleResponsesStreaming(body, chatRequest, abort.signal, res);
    } else {
      await handleResponsesBuffered(body, chatRequest, abort.signal, res);
    }
  } catch (err) {
    log("upstream failed:", err.message);
    if (res.writableEnded || abort.signal.aborted) return;
    if (wantsStream) {
      sseHead(res);
      const response = buildResponseObject(body, [], usageFrom({}), "failed");
      response.error = { code: "upstream_error", message: err.message };
      send(res, "response.failed", { response });
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      json(res, 502, errorPayload(err.message));
    }
  }
}

async function handleModels(req, res) {
  try {
    const upstream = await fetch(`${UPSTREAM_BASE_URL}/models`, {
      headers: UPSTREAM_API_KEY ? { authorization: `Bearer ${UPSTREAM_API_KEY}` } : {},
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const payload = await upstream.json();
    json(res, 200, payload);
  } catch (err) {
    json(res, 502, errorPayload(err.message));
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    json(res, 200, { ok: true, upstream: UPSTREAM_BASE_URL, key: UPSTREAM_API_KEY ? "set" : "missing" });
    return;
  }
  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    handleModels(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname.endsWith("/responses")) {
    handleResponses(req, res);
    return;
  }
  json(res, 404, errorPayload(`no route for ${req.method} ${url.pathname}`, "not_found"));
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`upstream ${UPSTREAM_BASE_URL} key=${UPSTREAM_API_KEY ? "set" : "MISSING"}`);
  if (!UPSTREAM_API_KEY) log("warning: no UPSTREAM_API_KEY / NVIDIA_API_KEY in env; upstream will 401");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} received, closing`);
    server.close(() => process.exit(0));
  });
}
