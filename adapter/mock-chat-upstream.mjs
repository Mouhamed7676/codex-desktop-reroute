#!/usr/bin/env node
// Offline fixture: pretends to be an OpenAI-compatible chat-completions host.
// Used to verify the responses adapter without spending tokens or holding a key.
// First request returns plain text; any request carrying a tool result returns
// a function_call, so both output-item paths get exercised.

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8899);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-chat-model", object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }

  const body = JSON.parse(await readBody(req));
  const hasToolResult = (body.messages ?? []).some((m) => m.role === "tool");
  const offered = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean);
  console.log(`[mock] messages=${body.messages?.length ?? 0} tools=${offered.join(",") || "none"} toolResult=${hasToolResult}`);

  // Tool result already came back: close the turn with plain text.
  if (hasToolResult) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "TOOL_OK: adapter carried a function_call and its result back." },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }),
    );
    return;
  }

  // First turn with tools available: demand a command, so the adapter's
  // function_call item path gets exercised by a real client.
  if (offered.includes("exec_command")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_mock_1",
                  type: "function",
                  function: { name: "exec_command", arguments: JSON.stringify({ cmd: "echo adapter-ok" }) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
    );
    return;
  }

  // No tools offered: plain text answer.
  const payload = {
    id: "chatcmpl-mock",
    object: "chat.completion",
    model: body.model,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "ADAPTER_OK: round trip reached the chat backend." },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 },
  };

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock chat upstream on http://127.0.0.1:${PORT}/v1`);
});
