# @orkestrel/mcp

A typed [Model Context Protocol](https://modelcontextprotocol.io) client/server
for the `@orkestrel` line, with pluggable HTTP, WebSocket, and stdio
transports. `createMCPServer` wraps a live `ToolManagerInterface`
(`@orkestrel/agent`) as an MCP server; `createMCPClient` drives a remote MCP
server and surfaces its tools as local `ToolInterface`s an agent can call as
if they were its own. The dispatch core is transport- and provider-agnostic
(`src/core` — JSON-RPC 2.0, no HTTP, no `as`); every transport (Streamable
HTTP over `@orkestrel/router` / `@orkestrel/server`, WebSocket over
`@orkestrel/websocket`, and stdio over `node:child_process`) lives one layer
out (`src/server`), each mechanism, not policy. Part of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/mcp
```

## Requirements

- Node.js >= 24
- ESM and CommonJS builds ship for both the core and server entry points
- `@orkestrel/server` and `@orkestrel/router` are peer dependencies (the HTTP
  spine the `./server` transports mount onto)

## Usage

Expose a tool registry over MCP, mounted on the HTTP spine:

```ts
import { createMCPServer } from '@orkestrel/mcp'
import { createMCPRoutes } from '@orkestrel/mcp/server'
import { createToolManager } from '@orkestrel/agent'

const tools = createToolManager()
tools.add({ id: 'add', name: 'add', execute: (a) => Number(a.x) + Number(a.y) })

const mcp = createMCPServer({ name: 'calculator', version: '1.0.0', tools })
const routes = createMCPRoutes(mcp) // POST /mcp dispatches JSON-RPC (JSON or SSE per Accept)
router.add(routes)
```

Drive a remote MCP server as a client, over the same transport-agnostic core:

```ts
import { createMCPClient } from '@orkestrel/mcp'
import { createHTTPClientTransport } from '@orkestrel/mcp/server'

const client = createMCPClient({
	transport: createHTTPClientTransport({ url: 'http://localhost:3000/mcp' }),
})
await client.connect()
const tools = await client.tools()
const value = await client.call('add', { x: 2, y: 5 })
```

The SAME `MCPClient` drives a `createWebSocketClientTransport` or
`createStdioClientTransport` instead — only the injected transport changes.

## Guide

For the full surface — the JSON-RPC dispatch core, the three server
transports (HTTP, WebSocket, stdio), the native session middleware, and
usage patterns — see [`guides/src/mcp.md`](guides/src/mcp.md).

## Package

Published with two entry points per the `exports` field in `package.json`:
the environment-agnostic core (`.`) and the Node-only server surface
(`./server`).

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
