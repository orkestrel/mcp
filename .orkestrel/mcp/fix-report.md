# MCP readiness fix report

## Findings

### MR1 — authored prose substitutions

Changed the prohibited-sense prose across `src/`, `guides/mcp.md`, and `README.md`. Representative corrections include the capability predicate wording at `guides/mcp.md:1759` and `guides/mcp.md:1770`, transport wording at `src/core/types.ts:2057`, and the closed result rule at `src/core/helpers.ts:435`.

Sweep command and paths:

```text
rg -n -i '\b(should|whitelist|via|e\.g\.|dummy|since|currently)\b' src/ guides/mcp.md README.md
```

No prohibited-sense hit remains. Six hits remain as protocol requirement terms:

- `guides/mcp.md:523`: `SHOULD` is the older protocol revision's normative client requirement.
- `guides/mcp.md:3684`: quoted `SHOULD` and `MAY` summarize the protocol's advisory cancellation requirements.
- `guides/mcp.md:3693`: `SHOULD` is the subscriptions page's normative server requirement.
- `guides/mcp.md:4434`: `SHOULD` repeats the older protocol revision's normative client requirement in the contract.
- `src/core/helpers.ts:395`: quoted `SHOULD` and `MAY` identify the protocol requirements that make cancellation advisory.
- `src/core/MCPClient.ts:907`: quoted `SHOULD` and `MAY` identify the same protocol requirements at the cancellation send site.

### MR2 and MR15 — README server example

Changed `README.md:43` to pass the required `identity: { name, version }` object to `createMCPServer`. The shape now matches `MCPServerOptions`; `npm run check` exits 0 for the source contracts.

### MR3 and MR14 — installed-consumer README links

Changed the guide destinations to repository URLs at `README.md:69` and `README.md:99`. Changed the repository-only changelog and license destinations to repository URLs at `README.md:77` and `README.md:123`. Added `README.md` to `ROOT_FILES` at `tests/guides.test.ts:51` and added the README relative-link assertion at `tests/guides.test.ts:91`.

Red:

```text
npx vitest run --config vite.config.ts --no-cache --reporter=dot tests/guides.test.ts -t 'README.md'
```

Exit 1: one failed assertion reported `guides/src/mcp.md#declared-packaging-limits`; 132 tests were skipped.

Green, with the same command: exit 0; one test passed and 132 tests were skipped.

### MR4 — stamped modern guide requests

Stamped every direct modern request example that claims a successful response. The affected examples include `guides/mcp.md:215`, `guides/mcp.md:374`, `guides/mcp.md:422`, `guides/mcp.md:1451`, `guides/mcp.md:2998`, and `guides/mcp.md:3350`. Each carries the modern protocol version and client-capability metadata. The bare notification at `guides/mcp.md:3012` remains headerless because notifications short-circuit before era dispatch and the example claims only `undefined`.

### MR5 — discovery deadline

Reconciled the client contract at `src/core/types.ts:2481` and `src/core/types.ts:2548` with the implementation's default deadline. Reconciled the contract clause at `guides/mcp.md:4132`. An omitted timeout selects `DEFAULT_MCP_REQUEST_TIMEOUT`; an explicit timeout also caps the connection probe at `DEFAULT_MCP_PROBE_TIMEOUT`.

### MR6 — WebSocket subprotocol selection

Changed `src/server/factories.ts:244` to parse the offered protocol list and pass the configured protocol to `createNodeWebSocket` only when the offer contains it. Updated the related browser, server, and guide statements. Added missing-offer, mismatched-offer, and matching-offer proofs at `tests/src/server/factories.test.ts:545`, `tests/src/server/factories.test.ts:555`, and `tests/src/server/factories.test.ts:566`. Extended the upgrade outcome recorder at `tests/setupServer.ts:556` and `tests/setupServer.ts:602` to retain the response protocol.

Sandbox reading:

```text
npx vitest run --config vite.config.ts --no-cache --reporter=dot --project src:server tests/src/server/factories.test.ts
```

Exit 1: 8 passed and 33 failed. Every listener-backed test, including the three new proofs, stopped at `listen EPERM: operation not permitted 0.0.0.0` in `Server.start`; none reached the upgrade assertion. This is the brief's stated sandbox-denial case.

### MR9 — subscription result names

Renamed the public contracts to `MCPSubscriptionResultMetaObject` and `MCPSubscriptionResult` at `src/core/types.ts:1332` and `src/core/types.ts:1338`. Updated construction at `src/core/helpers.ts:866`, the type proof at `tests/src/core/validators.test.ts:1976`, and guide parity at `guides/mcp.md:1911`.

Residue command:

```text
rg -n "SubscriptionsListenResult" src/ tests/ guides/ README.md
```

Exit 1 with no output, meaning no old name remains.

### MR10 — shared carrier role

Rewrote the `MCPClientTransportInterface` contract at `src/core/types.ts:2080` to describe the shared client and server-bridge message carrier and its browser/server implementations. Added the deferred rename decision at `ROADMAP.md:7`.

### MR11 — direct client event delegation

Removed `MCPClientInterface.on` between `src/core/types.ts:2510` and `src/core/types.ts:2540` and removed the implementing delegation between `src/core/MCPClient.ts:248` and `src/core/MCPClient.ts:252`. Updated MCP client consumers to subscribe through `client.emitter.on`, including `tests/src/core/MCPClient.test.ts` and `guides/mcp.md:2767`.

Residue command:

```text
rg -n "client\.on\(" src/ tests/ guides/mcp.md README.md
```

Exit 1 with no output.

### MR12 — capability predicate placement

Moved `isFormElicitationSupported` and `isTaskSupported` to `src/core/helpers.ts:78` and `src/core/helpers.ts:114`. Updated `MCPServer` to import both from helpers at `src/core/MCPServer.ts:74`. Removed their definitions and the now-unused task-extension constant import from validators. Updated their Helpers summaries at `guides/mcp.md:1759` and `guides/mcp.md:1770`.

### MR13 — duplex guide parity

Added `duplex` to the transport interface surface row at `guides/mcp.md:1932`, the data-member inventory at `guides/mcp.md:1948`, and the behavioral description at `guides/mcp.md:2833`.

### MR16 — source-map footprint

Measured the final built package with:

```text
npm_config_cache=/tmp/mcp-npm-cache npm pack --dry-run --json
```

The 2026-08-20 reading is 1,168,764 map bytes of 2,543,024 unpacked bytes, or 46.0 percent. Recorded the single reading at `README.md:111` and `guides/mcp.md:3815`; removed the conflicting approximate figures.

### MR17 — TSDoc first sentences

Changed authored source TSDoc first sentences from bare imperative verbs to third-person verbs across every `src/**/*.ts` file. Examples include `src/core/validators.ts:73`, `src/core/helpers.ts:126`, `src/core/types.ts:636`, `src/server/factories.ts:157`, and `src/browser/factories.ts:13`.

Extraction pattern and paths:

```text
perl -0777 -ne 'while (/\/\*\*\s*\n?\s*\*?\s*([A-Z][A-Za-z]+)\b/g) { ... }' $(rg --files src -g '*.ts')
```

Residue pattern and paths:

```text
perl -0777 -ne 'while (/\/\*\*\s*\n?\s*\*?\s*(Adapt|Answer|Ask|Boot|Bridge|Build|Call|Cancel|Close|Complete|Compose|Compute|Concatenate|Connect|Control|Create|Decide|Decode|Decorate|Deliver|Derive|Determine|Disconnect|Discover|Dispatch|End|Execute|Find|Fold|Handle|Infer|Intersect|Issue|Iterate|List|Map|Mirror|Narrow|Parse|Pipe|Produce|Protect|Publish|Pump|Read|Receive|Recover|Register|Report|Resolve|Send|Snapshot|Stamp|Take|Translate)\b/g) { ... }' $(rg --files src -g '*.ts')
```

The residue sweep returned no hit. No protocol quote was changed by this sweep.

## Verification

- `npm run lint:check` — exit 0.
- `npm run check` — exit 0 for root, core, browser, and server TypeScript projects.
- `npm run format:check` — exit 0 after `npm run format` converged the touched files.
- `npm run build` — exit 0 for core, browser, and server faces; the documented API Extractor TypeScript-version notice appeared once per face.
- `npx vitest run --config vite.config.ts --no-cache --reporter=dot --project src:core tests/src/core/helpers.test.ts tests/src/core/validators.test.ts tests/src/core/MCPClient.test.ts` — exit 1: 356 passed; two real-HTTP tests timed out after `listen EPERM: operation not permitted 127.0.0.1`. The helpers and validators files passed.
- `npm run test:guides` — exit 1: 129 passed; four spawned-child tests timed out under the brief's stated child-process restriction.
- `git diff --check` — exit 0.
- The browser project was not run, as required by the brief.

Flagged claim: the source change, type gates, and test definitions establish the MR6 selection rule, but this sandbox did not execute the three handshake assertions. The host reading remains required before treating that runtime behavior as proven.

## Diffstat

```text
 README.md                                          |  14 +-
 guides/mcp.md                                      | 466 +++++++++++----------
 src/browser/constants.ts                           |   8 +-
 src/browser/factories.ts                           |  16 +-
 src/browser/helpers.ts                             |  12 +-
 src/browser/transports/HTTPClientTransport.ts      |   6 +-
 src/browser/transports/MessagePortTransport.ts     |   4 +-
 src/browser/transports/WebSocketClientTransport.ts |   6 +-
 src/browser/types.ts                               |   8 +-
 src/core/MCPClient.ts                              |  11 +-
 src/core/MCPLegacy.ts                              |   4 +-
 src/core/MCPProgressReporter.ts                    |   8 +-
 src/core/MCPServer.ts                              |  10 +-
 src/core/MCPStreamController.ts                    |  14 +-
 src/core/MCPTextStreamController.ts                |  14 +-
 src/core/cloners.ts                                |   4 +-
 src/core/errors.ts                                 |   4 +-
 src/core/factories.ts                              |  15 +-
 src/core/helpers.ts                                | 129 ++++--
 src/core/inferers.ts                               |   6 +-
 src/core/parsers.ts                                |   6 +-
 src/core/types.ts                                  | 199 ++++-----
 src/core/validators.ts                             | 201 +++------
 src/server/MCPSession.ts                           |   4 +-
 src/server/factories.ts                            |  44 +-
 src/server/handlers.ts                             |   2 +-
 src/server/helpers.ts                              |  34 +-
 src/server/inferers.ts                             |   6 +-
 src/server/middlewares.ts                          |  10 +-
 src/server/transports/HTTPClientTransport.ts       |   6 +-
 src/server/transports/HTTPDisconnect.ts            |   6 +-
 src/server/transports/StdioClientTransport.ts      |   4 +-
 src/server/transports/StdioServerTransport.ts      |   2 +-
 src/server/transports/WebSocketClientTransport.ts  |   6 +-
 src/server/types.ts                                |  13 +-
 tests/guides.test.ts                               |  15 +-
 tests/setupServer.ts                               |  27 +-
 tests/src/core/MCPClient.test.ts                   |  46 +-
 tests/src/core/validators.test.ts                  |   6 +-
 tests/src/server/factories.test.ts                 |  32 ++
 40 files changed, 749 insertions(+), 679 deletions(-)
```

## Status

```text
 M README.md
 M guides/mcp.md
 M src/browser/constants.ts
 M src/browser/factories.ts
 M src/browser/helpers.ts
 M src/browser/transports/HTTPClientTransport.ts
 M src/browser/transports/MessagePortTransport.ts
 M src/browser/transports/WebSocketClientTransport.ts
 M src/browser/types.ts
 M src/core/MCPClient.ts
 M src/core/MCPLegacy.ts
 M src/core/MCPProgressReporter.ts
 M src/core/MCPServer.ts
 M src/core/MCPStreamController.ts
 M src/core/MCPTextStreamController.ts
 M src/core/cloners.ts
 M src/core/errors.ts
 M src/core/factories.ts
 M src/core/helpers.ts
 M src/core/inferers.ts
 M src/core/parsers.ts
 M src/core/types.ts
 M src/core/validators.ts
 M src/server/MCPSession.ts
 M src/server/factories.ts
 M src/server/handlers.ts
 M src/server/helpers.ts
 M src/server/inferers.ts
 M src/server/middlewares.ts
 M src/server/transports/HTTPClientTransport.ts
 M src/server/transports/HTTPDisconnect.ts
 M src/server/transports/StdioClientTransport.ts
 M src/server/transports/StdioServerTransport.ts
 M src/server/transports/WebSocketClientTransport.ts
 M src/server/types.ts
 M tests/guides.test.ts
 M tests/setupServer.ts
 M tests/src/core/MCPClient.test.ts
 M tests/src/core/validators.test.ts
 M tests/src/server/factories.test.ts
?? ROADMAP.md
```
