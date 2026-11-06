import { createServer } from "node:http";
import path from "node:path";

/**
 * A deterministic OpenAI-compatible test provider, NOT a mock of MCP.
 * It performs a built-in read only if OpenCode's known cold-start MCP tool
 * registration race leaves the first model request without Apex tools.
 *
 * Acceptance requires both actual MCP tool results to flow back through
 * the OpenCode agent. Missing tools after bounded probes are a hard failure.
 */
export async function createMockToolModel({ workspace } = {}) {
  let step = 0;
  let phase = "locate";
  let probes = 0;
  let verifiedLocate = false;
  let verifiedBundle = false;
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
        if (raw.length > 2_000_000) throw new Error("Oversized synthetic provider request");
      }
      const body = JSON.parse(raw);
      const advertised = (body.tools ?? [])
        .map(item => item.function?.name ?? item.name)
        .filter(Boolean);
      const messages = JSON.stringify(body.messages ?? []);
      observations.push({ step, phase, advertised });
      let selected;
      let functionArgs;
      const contains = needle => messages.includes(needle);
      if (phase === "locate") {
        selected = advertised.find(name => name.includes("apex") && name.includes("locate_code"));
        if (selected) {
          functionArgs = { query: "Button" };
          phase = "check-location";
        }
      }
      if (phase === "check-location" && !selected) {
        if (!contains("Button.tsx")) throw new Error("Real locate_code result never returned to OpenCode model");
        verifiedLocate = true;
        selected = advertised.find(name => name.includes("apex") && name.includes("read_context_bundle"));
        if (selected) {
          functionArgs = { filepath: "apps/web/src/components/Button.tsx", nodeName: "Button" };
          phase = "check-bundle";
        }
      }
      if (phase === "check-bundle" && !selected) {
        if (!contains("ButtonProps") || !contains("Apex Context Bundle")) {
          throw new Error("Real read_context_bundle result was not returned to OpenCode");
        }
        verifiedBundle = true;
        phase = "done";
      }
      if (!selected && phase !== "done") {
        if (!advertised.length) {
          // Some OpenCode versions issue a discovery/metadata request before
          // building the session tool catalog. Do not mutate test phase.
        } else if (probes < 3 && workspace && advertised.includes("read")) {
          probes++;
          selected = "read";
          functionArgs = { filePath: path.join(workspace, "apps/web/src/components/Button.tsx") };
        } else {
          throw new Error("Apex tools unavailable after " + probes
            + " real built-in-tool warmups; advertised=" + advertised.join(","));
        }
      }
      const id = "chatcmpl-apex-" + step++;
      const callId = "call_apex_" + step;
      const toolCall = selected ? {
        id: callId, type: "function", function: {
          name: selected, arguments: JSON.stringify(functionArgs),
        },
      } : null;
      const text = selected ? null : phase === "done"
        ? "Apex OpenCode end-to-end verification completed."
        : "Apex tool-discovery check.";
      const full = {
        id, object: "chat.completion", created: 1, model: "fixture",
        choices: [{
          index: 0,
          message: { role: "assistant", content: text, ...(toolCall ? { tool_calls: [toolCall] } : {}) },
          finish_reason: toolCall ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      };
      if (body.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(full)); return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const emit = (delta, finish_reason = null) => response.write("data: " + JSON.stringify({
        id, object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      }) + "\n\n");
      emit({ role: "assistant" });
      if (toolCall) emit({
        tool_calls: [{
          index: 0, id: toolCall.id, type: "function",
          function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
        }],
      });
      else emit({ content: text });
      emit({}, toolCall ? "tool_calls" : "stop");
      response.end("data: [DONE]\n\n");
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: {
        message: error instanceof Error ? error.message : "Unknown synthetic provider error",
        type: "invalid_request_error",
      } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic model did not bind a TCP port");
  return {
    baseURL: "http://127.0.0.1:" + address.port + "/v1",
    get step() { return step; },
    get probes() { return probes; },
    get verifiedLocate() { return verifiedLocate; },
    get verifiedBundle() { return verifiedBundle; },
    get observations() { return [...observations]; },
    close() { return new Promise(resolve => server.close(resolve)); },
  };
}
