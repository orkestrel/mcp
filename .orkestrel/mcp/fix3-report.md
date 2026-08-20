# Fix unit 3 report

The shipped TSDoc uses published package specifiers. No executable source line changed.

## Source sweep

The before sweep used this pattern against the committed baseline:

```text
git grep -n -E '^[[:space:]]*\*.*@src/' 40b5368 -- src
```

It found 49 TSDoc lines across these paths:

```text
src/browser/factories.ts: 8
src/browser/transports/HTTPClientTransport.ts: 2
src/browser/transports/MessagePortTransport.ts: 3
src/browser/transports/WebSocketClientTransport.ts: 1
src/browser/types.ts: 2
src/core/factories.ts: 2
src/core/inferers.ts: 1
src/server/factories.ts: 20
src/server/helpers.ts: 5
src/server/middlewares.ts: 2
src/server/transports/HTTPClientTransport.ts: 1
src/server/transports/WebSocketClientTransport.ts: 1
src/server/transports/WebSocketServerTransport.ts: 1
```

The face totals were `src/core`: 3, `src/server`: 30, and `src/browser`: 16.

The after sweep used this pattern:

```text
rg -n '^\s*\*.*@src/' src/
```

It returned no matches. The broader `rg -n "@src/" src/` sweep still returns the sanctioned module-scope imports and these 3 non-TSDoc comments, which the brief excludes:

```text
src/browser/types.ts:10:// (`src/server`), speaking the SAME `@src/core` `MCPClientTransportInterface` so
src/browser/types.ts:17:// to EITHER `bindServer` or `bindClient` (`@src/core`), the role coming from which
src/server/types.ts:7:// The HTTP transport mounts a transport-agnostic `MCPServerInterface` (the `@src/core` MCP
```

## Built declaration counts

`npm run build` exited 0. The required `rg -c "@src/"` search found no match. An explicit occurrence count produced these per-entry results:

```text
dist/src/core/index.d.ts: 0
dist/src/server/index.d.ts: 0
dist/src/browser/index.d.ts: 0
dist/src/core/index.d.cts: 0
dist/src/server/index.d.cts: 0
```

The built cross-face link is:

```text
dist/src/core/index.d.ts:614: * ({@link import('@orkestrel/mcp/server').inferHeaderIssue}): a modern request's reserved
```

Flagged claim: the build preserves the published `@orkestrel/mcp/server` specifier in the shipped link. The built declaration proves the emitted form; this unit did not run a separate editor link-resolution probe.

## `createToolManager` corrections

Five incorrect TSDoc import sites now name `@orkestrel/tool`:

```text
src/core/factories.ts:44
src/server/middlewares.ts:86
src/server/factories.ts:97
src/server/factories.ts:205
src/server/factories.ts:372
```

The pre-existing correct site remains at `src/server/handlers.ts:51`. The final `rg -n '^\s*\*.*import .*createToolManager.*from ' src/` result contains 6 sites, and every one names `@orkestrel/tool`.

## Acceptance evidence

The required gates ran in the brief's order:

```text
npm run lint:check   exit 0
npm run check        exit 0
npm run format:check exit 0
npm run build        exit 0
```

`git diff --check` returned no output. A zero-context diff filter returned no changed source line outside a ` *` comment line.

The actual `git status --short` output is:

```text
 M src/browser/factories.ts
 M src/browser/transports/HTTPClientTransport.ts
 M src/browser/transports/MessagePortTransport.ts
 M src/browser/transports/WebSocketClientTransport.ts
 M src/browser/types.ts
 M src/core/factories.ts
 M src/core/inferers.ts
 M src/server/factories.ts
 M src/server/helpers.ts
 M src/server/middlewares.ts
 M src/server/transports/HTTPClientTransport.ts
 M src/server/transports/WebSocketClientTransport.ts
 M src/server/transports/WebSocketServerTransport.ts
```

## Diffstat

```text
 src/browser/factories.ts                           | 16 ++++----
 src/browser/transports/HTTPClientTransport.ts      |  4 +-
 src/browser/transports/MessagePortTransport.ts     |  6 +--
 src/browser/transports/WebSocketClientTransport.ts |  2 +-
 src/browser/types.ts                               |  4 +-
 src/core/factories.ts                              |  5 ++-
 src/core/inferers.ts                               |  2 +-
 src/server/factories.ts                            | 43 ++++++++++++----------
 src/server/helpers.ts                              | 10 ++---
 src/server/middlewares.ts                          |  5 ++-
 src/server/transports/HTTPClientTransport.ts       |  2 +-
 src/server/transports/WebSocketClientTransport.ts  |  2 +-
 src/server/transports/WebSocketServerTransport.ts  |  2 +-
 13 files changed, 54 insertions(+), 49 deletions(-)
```
