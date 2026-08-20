# mcp fix unit 2 report

## Items

### Authored-prose sweep

The final sweep was:

```text
rg -n 'e\.g\.|i\.e\.' src guides/mcp.md README.md
```

It exited 1 with no output. Its coverage is exactly authored prose in `src/`, `guides/mcp.md`,
and `README.md`. It does not claim coverage of tests, other guides, dependencies, generated files,
or campaign records. No hit was kept.

Each original hit used the example sense and changed to `for example`:

- `src/core/types.ts:46` introduces `notifications/initialized` as one notification example.
- `src/core/types.ts:1659` introduces `tools/call` as one method-name example.
- `src/core/types.ts:2188` introduces `notifications/tools/list_changed` as one notification example.
- `src/browser/types.ts:61` introduces an authorization bearer as one headers example.
- `src/browser/types.ts:85` introduces one side of a `MessageChannel` as one port example.
- `src/browser/types.ts:139` introduces an identity-gate callback as one `accept` example.
- `src/browser/factories.ts:62` introduces an authorization bearer as one headers example.
- `src/browser/transports/HTTPClientTransport.ts:37` introduces an authorization bearer as one headers example.
- `src/server/types.ts:281` introduces a localhost MCP URL as one endpoint example.
- `src/server/types.ts:283` introduces an authorization bearer as one HTTP headers example.
- `src/server/types.ts:341` introduces an authorization bearer as one WebSocket headers example.
- `src/server/types.ts:363` introduces `node` and a relative executable as command examples.
- `src/server/factories.ts:127` introduces an authorization bearer as one HTTP headers example.
- `src/server/factories.ts:284` introduces an authorization bearer as one WebSocket headers example.
- `src/server/helpers.ts:396` introduces `undefined` as one result that serializes away.
- `src/server/transports/HTTPClientTransport.ts:34` introduces an authorization bearer as one headers example.

The original sweep found no `i.e.` hit in the stated coverage.

### F1 — WebSocket selection wording

At `tests/src/browser/factories.test.ts:134`, the test title now states that the client offers the
default `mcp` token selected by `createWebSocketServer`. The comment now states the selection rule:
the server selects its configured token only when the client's offer contains it.

### F2 — source-map prose

At `README.md:108` and `guides/mcp.md:3824`, the prose no longer fixes the source-map population to
five files. The measured 1,168,764-byte, 2,543,024-byte, 46.0-percent, and 2026-08-20 facts remain.

### F3 — deferred rename

The `ROADMAP.md` file was deleted. At `guides/mcp.md:3766`, declared-gaps prose records that the
`MCPClientTransportInterface` rename remains deferred past the readiness wave and that the public
name remains the contract until one unit owns the rename and every consumer update.

### Dead changelog link

The changelog sentence between `README.md:71` and `README.md:77` was deleted. The final command was:

```text
rg -n 'CHANGELOG' README.md
```

It exited 1 with no output.

### R1 — README link population

At `tests/guides.test.ts:96`, the gate reads the full README link set, requires that set to be
non-empty, and rejects a member unless it is an absolute URL accepted by `URL.canParse` or resolves
to a repository-relative path present in the inventory.

The red control temporarily supplied an empty readonly link set. This exact scoped command:

```text
npm run test:guides -- -t 'README.md|tools/list request metadata'
```

reported `2 failed | 132 skipped`; the README test failed at `expected 0 to be greater than 0`.
After restoring `readme.links()`, the same command reported `2 passed | 132 skipped`.

### R2 — executed `tools/list` transcription

At `tests/guides.test.ts:476`, an in-process `MCPServer` with the guide's calculator tool receives
the bare and stamped `tools/list` requests. The test asserts the bare request's exact `-32602`
malformed-metadata response and the stamped request's exact successful result, including its tool,
result stamps, cache values, and server identity.

The red control temporarily replaced the stamped success input with the bare request. The same
scoped command reported `2 failed | 132 skipped`; this test received:

```text
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid params: malformed modern request metadata"}}
```

where it expected the stamped success. After restoring the stamped request, the same command
reported `2 passed | 132 skipped`. The transcription ran in this sandbox without a listener.

At `guides/mcp.md:3770`, declared-gaps prose records that the other corrected fences retain prose,
named-import, symbol, and link checks but no executed transcription.

## Verification

The final acceptance commands returned these results on the restored tree:

- `npm run lint:check` exited 0.
- `npm run check` exited 0 across the root, core, browser, and server TypeScript projects.
- `npm run format:check` exited 0 after `npm run format` corrected `tests/guides.test.ts`.
- `rg -n 'e\.g\.|i\.e\.' src guides/mcp.md README.md` exited 1 with no output.
- `test ! -e ROADMAP.md` exited 0.
- `rg -n 'CHANGELOG' README.md` exited 1 with no output.
- `git diff --check` exited 0.

An unfiltered guide run made while the two red controls were installed also timed out the four
existing stdio child-process transcriptions at their 5-second test limit. The final claimed guide
reading is the scoped in-process R1/R2 command stated earlier. No loopback listener was opened.

Own claims flagged: none.

## Status

```text
 M README.md
 D ROADMAP.md
 M guides/mcp.md
 M src/browser/factories.ts
 M src/browser/transports/HTTPClientTransport.ts
 M src/browser/types.ts
 M src/core/types.ts
 M src/server/factories.ts
 M src/server/helpers.ts
 M src/server/transports/HTTPClientTransport.ts
 M src/server/types.ts
 M tests/guides.test.ts
 M tests/src/browser/factories.test.ts
```

## Diffstat

```text
 README.md                                     |  5 +---
 ROADMAP.md                                    |  7 -----
 guides/mcp.md                                 | 11 +++++++-
 src/browser/factories.ts                      |  2 +-
 src/browser/transports/HTTPClientTransport.ts |  2 +-
 src/browser/types.ts                          |  6 ++---
 src/core/types.ts                             |  6 ++---
 src/server/factories.ts                       |  4 +--
 src/server/helpers.ts                         |  2 +-
 src/server/transports/HTTPClientTransport.ts  |  2 +-
 src/server/types.ts                           |  8 +++---
 tests/guides.test.ts                          | 38 ++++++++++++++++++++++-----
 tests/src/browser/factories.test.ts           |  8 +++---
 13 files changed, 62 insertions(+), 39 deletions(-)
```
