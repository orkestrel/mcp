# HS-U4 report: examples, guide, README, and the executed fence

Unit complete. No deviation. Every acceptance criterion ran green in brief order, on 2026-08-20.

## Item 1 — the examples

Every listed site composes `createMCPLegacy(mcp)` and carries the identical trailing comment
`// answers \`initialize\` too; pass \`mcp\` alone for modern-only`. Where a site already carried a
trailing comment stating something else, that sentence moved to a preceding line comment so the
fixed comment sits in the trailing position at every site.

| Site | Line | As changed |
| ---- | ---- | ---------- |
| `src/server/factories.ts` `createMCPRoutes` | 100 | already composed; its comment normalized from `// both eras; pass \`mcp\` for modern only` to the fixed one |
| `src/server/factories.ts` `createWebSocketServer` | 209 | composed; import gained `createMCPLegacy`; `// ws://…/mcp` became the preceding `// Claims the MCP upgrade at ws://…/mcp:` |
| `src/server/factories.ts` `createStdioServer` | 377 | composed; import gained `createMCPLegacy`; the stdio sentence became the preceding line comment |
| `src/server/middlewares.ts` `createMCPSession` | 91 | composed; import gained `createMCPLegacy`; `// the route stays session-agnostic` became the preceding line comment |
| `src/browser/factories.ts` `createMessagePortTransport` | 119 | composed; import gained `createMCPLegacy`; the server construction was hoisted to a `mcp` const so the composition reads at one width |
| `guides/mcp.md` § HTTP transport | 1975 | composed; import gained `createMCPLegacy`; the POST sentence became the preceding line comment |
| `guides/mcp.md` § WebSocket transport | 2194 | composed; import gained `createMCPLegacy` |
| `guides/mcp.md` § stdio transport | 2288 | composed; import gained `createMCPLegacy`; the stdio sentence became the preceding line comment |
| `guides/mcp.md` § Mount the HTTP transport with sessions | 3056 | composed; import gained `createMCPLegacy`; the shared-policy sentence became the preceding line comment, which now also names the `initialize` mint |
| `README.md` headline | 45 | composed; import gained `createMCPLegacy`; the POST sentence became the preceding line comment |

The retained modern-only example is `guides/mcp.md:1558`, `createMCPRoutes(mcp) // modern only — a
legacy request falls off the modern seam as -32601`, adjacent to the composed line at 1557 in
§ Compose or remove the legacy protocol layer. Its pair was left as written: that section's whole
subject is the contrast, its comments already state which line reaches which era, and stamping
the fixed comment on line 1557 would restate the line under it.

Sites ruled out, with the reason:

- `src/server/handlers.ts:54` (`createMCPPostHandler(createMCPLegacy(mcp), …)`) already composes the
  wrapper and carries no trailing comment. The file is not in this unit's owned list, so it is
  report-only. Patch, if the Orchestrator wants the comment identical there too:
  `- * const handler = createMCPPostHandler(createMCPLegacy(mcp), { streaming: true })`
  `+ * const handler = createMCPPostHandler(createMCPLegacy(mcp), { streaming: true }) // answers \`initialize\` too; pass \`mcp\` alone for modern-only`
- `src/server/helpers.ts:409` (`bindServer(mcp, bridgeMessageTransport(transport))`) is the adapter's
  own example over an opaque dispatcher parameter; it mounts no deployment and claims no era reach.
  Not owned either way.
- `src/browser/factories.ts:150` (`bindServer(server, scopeTransport)`) and `src/core/helpers.ts:1124`
  (`bindServer(server, transport)`) name a free `server` binding rather than constructing one, so
  there is nothing to decorate without inventing a construction the example does not make.
- `guides/mcp.md:1514` (`bindServer(server, serverSide)`) is the loopback fence: the fence owns each half,
  the client it drives is this package's own modern client, and the reconciliation's
  site list does not name it.
- `guides/mcp.md:3226` (`createMCPPostHandler(mcp, …)`) is a helper-inventory fence over an
  undeclared `mcp` binding.
- `guides/mcp.md:2051`, `guides/mcp.md:4043`, `guides/mcp.md:4226`, `guides/mcp.md:4288`, and
  `guides/mcp.md:4339` cite signatures or name the dispatcher parameter in prose.

## Item 2 — the guide's handshake contract

Homes chosen, one fact per home:

- **The pin contract** → `guides/mcp.md:2758`, a new paragraph in `#### MCPClientInterface`, between
  the methods table and the discovery-snapshot paragraph. It states the exact pin, the modern and
  legacy arms, the `createMCPClient` construction throw with `{ supported, requested }` before the
  emitter and transport subscription exist, and the `connect` refusal naming what the peer offered
  (`supported` from discovery for a modern pin, `negotiated` from the handshake reply for a legacy
  one). It is the consumer-facing home, beside the `connect` row that summarizes negotiation.
- **The unpinned landing and the absent downgrade signal** → the same paragraph, because they are
  the same subject: what pinning buys. `version` carries the fact; there is no second signal.
- **The worst case with the cap removed** → `guides/mcp.md:4166`, Contract clause 14, appended to the
  probe-deadline sentences that clause already owns. It names `-32601` from the TypeScript SDK
  server and `-32602` from the Python SDK server, each read from its released 1.x server source on
  2026-08-20, links both sources, states that any discovery failure short of
  `MCP_UNSUPPORTED_VERSION` falls back, and separates the silent-peer case, which costs the
  configured deadline before the fallback and the deadline again on the `initialize` after it.
- **The WebSocket prose correction** → `guides/mcp.md:2200` and `guides/mcp.md:2410`.

### Replaced versus added

Replaced sentences:

- `guides/mcp.md:4100` — clause 13's rejection enumeration. Was `A legacy result's absent,
  malformed, modern, or unsupported \`protocolVersion\` rejects`; now `A legacy result's absent,
  malformed, modern, unsupported, or pin-mismatched \`protocolVersion\` rejects, as does a discovery
  advertisement that omits a pinned modern revision`. The list was false by omission after HS-U1,
  and correcting it in place keeps clause 13 the single exhaustive negotiation enumeration rather
  than creating a second copy of the pin contract there.
- `guides/mcp.md:2200` — was `// the RFC 6455 handshake, then the MCP initialize over frames`; now
  `// the RFC 6455 handshake, then modern \`server/discover\` over frames`. The claim is false with or
  without the decorator: an unpinned client against a peer that serves the modern seam negotiates
  through discovery and sends no `initialize`.
- `guides/mcp.md:2410` — the browser face carried the same false claim
  (`then the MCP initialize runs over WS frames`); corrected the same way. Fixing one WebSocket
  spelling and leaving the other would leave the drift in place under a different heading.
- `guides/mcp.md:2295` — was `client.version // the negotiated legacy revision`; now
  `client.version // the revision negotiated with that child — legacy where it serves no modern seam`.
  That comment asserted a downgrade unconditionally against an unspecified `./server.js`, which is
  exactly the fact the pin paragraph now bounds.
- `guides/mcp.md:3435` — the Tests row for `tests/guides.test.ts` gained the composed-stdio proof, so
  the guide's own test list matches what that file now proves.
- The per-site trailing comments listed under Item 1.

Added sentences: the pin paragraph at `guides/mcp.md:2758`, and the worst-case block inside clause 14
at `guides/mcp.md:4166`. Nothing else in the guide states either fact, so neither has a second home.

The unknown the brief named is closed: no section stated the pin contract or the fallback cost in
other words. Clause 13 stated the negotiation path and clause 14 the probe deadline, and each new
fact was placed against the clause that already owned its subject rather than beside it.

## Item 3 — the executed fence

`tests/guides.test.ts:815-893` transcribes the flagship `createStdioServer` fence and drives it over
the injectable stream pair `StdioServerOptions` documents, through the same `createStdioServer` call
the fence makes.

- `guides/mcp.md § stdio transport — what the composed server answers > answers a legacy initialize,
  as the composed fence claims` asserts the whole reply envelope: `protocolVersion` `2025-11-25`,
  `capabilities: { tools: {} }`, `serverInfo` `docs` / `1.0.0`.
- `… > CONTROL — the bare dispatcher the comment names refuses that same handshake` drives the
  undecorated server through the identical harness and asserts
  `error: { code: -32601, message: 'Method not found: initialize' }`. The control sits outside the
  decorated population and executes the second half of the fixed comment: it is the modern-only
  subtraction the comment promises.

Instrument evidence, taken by mutating the composed test's argument from
`createMCPLegacy(createGuideServer())` to `createGuideServer()` and restoring it:

- `npx vitest run --config vite.config.ts --reporter=dot --project guides -t "what the composed
  server answers"` → `Tests 1 failed | 1 passed | 134 skipped (136)`, the failure being the composed
  row's envelope comparison at `tests/guides.test.ts:873`.
- The same command after restoring → `Tests 2 passed | 134 skipped (136)`.

## Item 4 — parity

`guides/README.md` needed no change: no concept row, directory row, or guide file moved. The guide's
Tests list row for `tests/guides.test.ts` was widened, as recorded. No Surface, Factories, Entities,
Constants, Helpers, or Types row changed, because no export moved; every backticked name added to
prose (`SUPPORTED_PROTOCOL_VERSIONS`, `MCP_UNSUPPORTED_VERSION`, `MCPError`, `createMCPClient`,
`DEFAULT_MCP_REQUEST_TIMEOUT`, `createMCPLegacy`) is an existing documented export, and every fence
import resolves; `npm run test:guides` proves that.

## Acceptance criteria

1. `npm run lint:check` → exit 0.
2. `npm run check` → exit 0 (root `tsc`, then `check:src:core`, `check:src:browser`, `check:src:server`).
3. `npm run format:check` → exit 0, `All matched files use the correct format`, 201 files. No `format`
   run was needed.
4. `rg -n "createStdioServer\(mcp\)|createWebSocketServer\(mcp" src/ guides/ README.md` → one line:
   `guides/mcp.md:4226:    upgrade seam (\`src/server\`).** \`createWebSocketServer(mcp, options)\``.
   That is Contract clause 16 citing the factory's signature with its declared parameter name, not an
   example composing a server, so no example composition remains outside the labeled modern-only one
   at `guides/mcp.md:1558`. Renaming the parameter in that citation would misstate the signature, so
   it is reported rather than edited.
5. `npm run test:guides` → exit 0. `Test Files 1 passed (1)`, `Tests 136 passed (136)`,
   `Duration 5.57s`. The baseline was 134: `-t "what the composed server answers"` reports
   `Tests 2 passed | 134 skipped (136)`.
6. `npm run build` → exit 0. The TSDoc edits ride into the declarations:
   `dist/src/server/index.d.ts` carries the fixed comment at 244, 311, 387, and 480, and
   `dist/src/browser/index.d.ts` at 77.

## Review evidence

`git diff --stat`:

```text
 README.md                 |  5 +--
 guides/mcp.md             | 63 ++++++++++++++++++++++++++--------
 src/browser/factories.ts  |  5 +--
 src/server/factories.ts   | 12 ++++---
 src/server/middlewares.ts |  5 +--
 tests/guides.test.ts      | 87 +++++++++++++++++++++++++++++++++++++++++++++--
 6 files changed, 148 insertions(+), 29 deletions(-)
```

`git status --short`:

```text
 M README.md
 M guides/mcp.md
 M src/browser/factories.ts
 M src/server/factories.ts
 M src/server/middlewares.ts
 M tests/guides.test.ts
```

Every modified file is owned. No off-limits file was touched, and `dist/` is ignored.
