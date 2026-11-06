# Demo

## Prerequisites
- Node.js >= 18 (verified in this environment on Node 24.x; CI tests Node 20/22).
- Dependencies installed and project built.

## Run
```bash
npm ci --ignore-scripts --no-fund
npm run build
npm run demo
```

## What the demo does (real MCP client + real stdio server)
1. Creates an **isolated temporary** demo workspace (no user/global config changes).
2. Launches the compiled `dist/index.js` MCP server over stdio.
3. Connects a real MCP client (`@modelcontextprotocol/sdk`).
4. Lists registered tools (expects 15).
5. Indexes the demo workspace.
6. Locates a symbol/route/component (`Button`/`Page`) and retrieves edit-ready context.
7. Modifies a workspace file externally and retrieves fresh results **without restarting** the server (`ButtonSentinel`).
8. Verifies synthetic-secret redaction and authorized-root protection.
9. Closes client/server and removes temporary resources.
10. Exits nonzero on assertion failure.

## Expected output (representative)
```text
1) MCP connected
2) Tools listed: 15
Workspace Memory - ...
3) Workspace indexed
4) locate_code(Button): ...
5) read_context_bundle(Page) returned
6) Freshness after external edit (no restart): ButtonSentinel found
7) Synthetic secret redaction: PASS
8) Outside-root protection: PASS
DEMO PASS
```

Exact counts/timings vary by machine.
