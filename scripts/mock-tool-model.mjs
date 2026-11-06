import { createServer } from "node:http";

/**
 * Deterministic OpenAI-compatible model stub used only by the OpenCode client smoke.
 * An LLM is not involved; the stub requests actual MCP tools and checks returned content.
 */
export async function createMockToolModel() {
  let step = 0;
  const observations = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "fixture", object: "model", owned_by: "apex" }] }));
      return;
    }
    if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
      response.writeHead(404); response.end("not found"); return;
    }
    let raw = "";
    try {
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 2_000_000) throw new Error("Oversized mock provider request");
      }
      const body = JSON.parse(raw);
      const advertised = (body.tools ?? []).map(item => item.function?.name ?? item.name).filter(Boolean);
      observations.push({ step, advertised, messages: body.messages ?? [] });
      const want = step === 0 ? "locate_code" : step === 1 ? "read_context_bundle" : null;
      const selected = want
        ? advertised.find(name => name.includes("apex") && name.includes(want))
        : undefined;
      if (want && !selected) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "OpenCode did not expose Apex " + want, type: "invalid_request_error" } }));
        return;
      }
      if (step > 0) {
        const contents = JSON.stringify(body.messages ?? []);
        if (!contents.includes(step === 1 ? "Button.tsx" : "ButtonProps")) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Prior Apex tool result absent from OpenCode context", type: "invalid_request_error" } }));
          return;
        }
      }
      const id = "chatcmpl-apex-" + step;
      const callId = "call_apex_" + step;
      const functionArgs = JSON.stringify(step === 0
        ? { query: "Button" }
        : { filepath: "apps/web/src/components/Button.tsx", nodeName: "Button" });
      const streaming = body.stream !== false;
      const toolCall = selected ? {
        id: callId, type: "function", function: { name: selected, arguments: functionArgs },
      } : null;
      const full = {
        id, object: "chat.completion", created: 1, model: "fixture",
        choices: [{
          index: 0, message: {
            role: "assistant", content: selected ? null : "Apex OpenCode end-to-end verification completed.",
            ...(toolCall ? { tool_calls: [toolCall] } : {}),
          },
          finish_reason: toolCall ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      };
      step++;
      if (!streaming) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(full));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const event = (delta, finish_reason = null) =>
        response.write("data: " + JSON.stringify({
          id, object: "chat.completion.chunk", created: 1, model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        }) + "\n\n");
      event({ role: "assistant" });
      if (toolCall) event({
        tool_calls: [{
          index: 0, id: toolCall.id, type: "function",
          function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
        }],
      });
      else event({ content: full.choices[0].message.content });
      event({}, toolCall ? "tool_calls" : "stop");
      response.end("data: [DONE]\n\n");
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error), type: "server_error" } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock model did not bind a TCP port");
  return {
    baseURL: "http://127.0.0.1:" + address.port + "/v1",
    get step() { return step; },
    get observations() { return [...observations]; },
    close() { return new Promise(resolve => server.close(resolve)); },
  };
}
