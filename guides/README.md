# Guides

A dual-axis index into this repository's guides — by concept, and by directory (AGENTS §22).

## By concept

| Concept | Spec                       | Source                                                   | Tests                                                                            |
| ------- | -------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| MCP     | [`src/mcp.md`](src/mcp.md) | [`src/core`](../src/core), [`src/server`](../src/server) | [`tests/src/core`](../tests/src/core), [`tests/src/server`](../tests/src/server) |

## By directory

| Directory    | Guide                      |
| ------------ | -------------------------- |
| `src/core`   | [`src/mcp.md`](src/mcp.md) |
| `src/server` | [`src/mcp.md`](src/mcp.md) |

## Dependency reference

[`src/emitter.md`](src/emitter.md) is a byte-identical mirror of the guide for
`@orkestrel/emitter` — a runtime dependency, the typed push-observation
surface every entity in this package exposes as `emitter` (`MCPServer`,
`MCPClient`, and every `ClientTransportInterface` implementation). It
documents **that package's** surface, not anything sourced in this repo; it
is kept here so a reader of this package can see the primitive it is built
from without leaving this guide set.

[`src/contract.md`](src/contract.md) is a byte-identical mirror of the guide
for `@orkestrel/contract` — a runtime dependency, the `Guard<T>` vocabulary
(`isString`, `isRecord`, …) the wire-boundary validators in this package are
built from (no `as` anywhere on the JSON-RPC / HTTP boundary). It documents
**that package's** surface, not anything sourced in this repo; it is kept
here for the same reason.

[`src/agent.md`](src/agent.md) is a byte-identical mirror of the guide for
`@orkestrel/agent` — a runtime dependency, the `ToolManagerInterface` /
`ToolInterface` / `ToolResult` vocabulary `createMCPServer` exposes over MCP
and `createMCPClient` wraps a remote server's tools back into. It documents
**that package's** surface, not anything sourced in this repo; it is kept
here so a reader of this guide can see the tool-registry primitive without
leaving this guide set.

[`src/sse.md`](src/sse.md) is a byte-identical mirror of the guide for
`@orkestrel/sse` — a runtime dependency, the `SSEParserInterface` the HTTP
client transport's `readEventStream` decodes a Streamable-HTTP SSE reply
with. It documents **that package's** surface, not anything sourced in this
repo; it is kept here for the same reason.

[`src/websocket.md`](src/websocket.md) is a byte-identical mirror of the
guide for `@orkestrel/websocket` — a runtime dependency, the RFC 6455
`NodeWebSocketInterface` wrapper both WebSocket transports compose over. It
documents **that package's** surface, not anything sourced in this repo; it
is kept here so a reader of this guide can see the WebSocket primitive
without leaving this guide set.

[`src/server.md`](src/server.md) is a byte-identical mirror of the guide for
`@orkestrel/server` — a peer dependency, the `openStream` SSE seam, the
`MiddlewareHandler` / `UpgradeHandler` contracts, and the `StreamInterface`
`MCPSession` attaches to. It documents **that package's** surface, not
anything sourced in this repo; it is kept here so a reader of this guide can
see the spine primitive this package's HTTP and WebSocket transports mount
onto without leaving this guide set.

[`src/router.md`](src/router.md) is a byte-identical mirror of the guide for
`@orkestrel/router` — a peer dependency, the `RouteInput` shape
`createMCPRoutes` returns. It documents **that package's** surface, not
anything sourced in this repo; it is kept here for the same reason.

[`src/guide.md`](src/guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides/src/parity.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not
anything sourced in this repo; it is kept here so a reader of the parity suite
can see the primitives it is built from without leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
