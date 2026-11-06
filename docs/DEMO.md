# Clean-room demonstration

Requires Node 20 or 22 and npm. No private repository, API key, OpenCode installation or Docker.

```bash
git clone https://github.com/dthompsonfl/apex-context-server.git
cd apex-context-server
npm ci --ignore-scripts --no-fund
npm run typecheck
npm run build
npm run demo
```

`scripts/demo.mjs` copies `examples/demo-workspace` to a temporary location, launches a real `Client` and `StdioClientTransport` against `dist/index.js` and verifies:

1. MCP initialize and exactly 15 tools.
2. Real workspace indexing, symbol lookup and Next.js page lookup.
3. An edit-ready `Button` bundle containing its props.
4. An external file creation reflected on the same live MCP connection.
5. Synthetic multiline private-key redaction in AST context.
6. Rejection of source reads outside the authorized workspace.
7. Nonzero exit on failed assertions and cleanup of temporary paths.

Expected final message: `DEMO PASSED`. The actual returned paths/counts depend on the fixture and revision. This is not simulated output.

Additional checks: `npm run smoke:mcp`, `npm run test:security`, `npm run test:installer` and `npm run bench`.

For manual Inspector use after independently installing an appropriate CLI release:

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
```

The Inspector is not required by CI. Real OpenCode version-specific tool invocation remains separate from SDK interoperability.

Troubleshooting: missing dist means run `npm run build`; missing modules means `npm ci`; corrupt cache means stop the process and remove only the matching cache JSON; installer ownership conflicts require reviewing the manifest rather than force-removing user files.
