# @orkestrel/mcp

A typed [Model Context Protocol](https://modelcontextprotocol.io) client/server
for the `@orkestrel` line, bridging the `@orkestrel/tool` registry to MCP with
pluggable HTTP, WebSocket, and stdio transports. `createMCPServer` exposes a
live `ToolManagerInterface`; `createMCPClient` drives a remote MCP server and
surfaces its tools as local `ToolInterface`s. No agent runtime is required.
The dispatch core is transport- and provider-agnostic
(`src/core` — JSON-RPC 2.0, no HTTP, no `as`); every transport (Streamable
HTTP over `@orkestrel/router` / `@orkestrel/server`, WebSocket over
`@orkestrel/websocket`, and stdio over `@orkestrel/process`) lives one layer
out (`src/server`), each mechanism, not policy. Part of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/mcp
```

## Requirements

- Node.js >= 22.12.0
- ESM and CommonJS builds ship for both the core and server entry points; the
  browser entry point ships ESM only
- TypeScript `moduleResolution` set to `node16`, `nodenext`, or `bundler`. Under
  legacy `node` resolution the `./browser` and `./server` subpaths resolve no
  declarations
- `@orkestrel/server` and `@orkestrel/router` are peer dependencies (the HTTP
  spine the `./server` transports mount onto)

## Usage

Expose a tool registry over MCP, mounted on the HTTP spine:

```ts
import { createMCPServer } from '@orkestrel/mcp'
import { createMCPRoutes } from '@orkestrel/mcp/server'
import { createTool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))

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

For the full surface — the JSON-RPC dispatch core, the server transports
(HTTP, WebSocket, stdio), the native session middleware, and usage
patterns — see [`guides/src/mcp.md`](guides/src/mcp.md).

## Package

Published per the `exports` field in `package.json`: the
environment-agnostic core (`.`), the Node-only server surface (`./server`),
and the browser face (`./browser`), which is ESM only.

[`CHANGELOG.md`](CHANGELOG.md) lives in the repository and is not in the
tarball, because `files` is `["dist/src", "README.md"]`.

## Proven

`npm run test:conformance` starts the real Streamable HTTP server from this
package's source and runs
`@modelcontextprotocol/conformance@0.2.0-alpha.10` against MCP revision
`2026-07-28`. The recorded result is **23 passed / 0 failed**. That is a
genuine foreign MCP client driving this server end to end, and it is
evidence about the wire. It resolves the runner from `node_modules` and
drives a loopback socket, so the run is offline and `npm test` gates it.

**IDE integration is not claimed.** No IDE, editor, or agent host has driven
this server. A claim about an external client stays unproven here until one
representative real client of that class drives it end to end, and no client
of the IDE class has.

## Declared limits

The publication facts, each with its number. Full detail, plus every
protocol-level gap and non-goal, is in
[`guides/src/mcp.md`](guides/src/mcp.md#declared-packaging-limits).

- **No IDE evidence.** See above. The conformance number is about the wire
  and does not transfer to a host application.
- **No top-level `types` field.** Every `exports` subpath carries a `types`
  condition, so `node16`, `nodenext`, and `bundler` resolution find
  declarations. A consumer on legacy `moduleResolution: node` does not read
  `exports` and sees an untyped package.
- **A build-time version notice on every built face.** API Extractor bundles
  TypeScript 5.9.3 through a transitive pin and this project compiles with
  6.0.3, so `build` prints one notice per built face. It is informational:
  `build` exits 0 and every declaration is emitted.
- **Source maps ship.** The `.map` files are 1,130 kB of the 2.5 MB
  unpacked, about 45 percent. They are kept so a consumer debugging a
  protocol library steps into real source.

The notice, verbatim:

```text
*** The target project appears to use TypeScript 6.0.3 which is newer than the bundled compiler engine; consider upgrading API Extractor.
```

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
