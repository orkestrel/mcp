# mcp readiness matrix — reconciled 2026-08-20

Lanes returned: canon (Luna), objective (Sol), subjective (Opus reviewer). All rows ruled.

| Row | Finding | Ruling | Carrier |
| --- | ------- | ------ | ------- |
| MR1 | Writing-canon hits in authored TSDoc and guide (`SHOULD`, `WHITELIST`, `via`, `e.g.`, `dummy`, causal `since`, `currently`; guides/mcp.md:767 and named source lines) | Accepted, convergent across blind lanes; rule each hit by sense during the sweep | mcp fix unit |
| MR2 | README server example passes `{ name, version, tools }`; `MCPServerOptions` requires `identity` (README:43 vs types.ts:1776) | Accepted, convergent across blind lanes | mcp fix unit |
| MR3 | README guide links target absent `guides/src/mcp.md`; the tarball excludes guides | Accepted; fix the destinations to reachable URLs for an installed consumer | mcp fix unit |
| MR4 | Guide's bare `tools/list` example claims success; executing it returns -32602 (guides/mcp.md:215); stamped control succeeds | Accepted with executed evidence; stamp every bare modern example | mcp fix unit |
| MR5 | Guide claims unbounded default discovery (guides/mcp.md:4093); MCPClient.ts:219 assigns the default request deadline | Accepted; reconcile prose with the type documentation and implementation | mcp fix unit |
| MR6 | Server claims a WebSocket upgrade with `Sec-WebSocket-Protocol: mcp` when the client offered no subprotocol (factories.ts upgrade handler); RFC 6455 requires the client to reject an unsolicited subprotocol, and the repo's own browser test records it | Accepted with executed evidence and a matching-offer control. Claim the header only when the offer list carries the configured protocol; add missing, mismatched, and matching handshake proofs red-then-green | mcp fix unit |
| MR7 | Artifact proof did not cover the published `./browser` entry | Closed: the Orchestrator's follow-up proof resolves and loads `@orkestrel/mcp/browser` from the installed tarball (2026-08-20, exit 0) | closed |
| MR8 | Canon lane unresolved rows (suite execution, surface size) | Suite rows close via the verifier's host gates; the subjective lane returned no surface-size finding, so that half closes with its verdict | verifier / closed |
| MR9 | Subjective lane: `SubscriptionsListenResult` and `SubscriptionsListenResultMetaObject` break the `MCP`-prefixed result naming (types.ts:1332, :1338) | Accepted; rename to `MCPSubscriptionResult` and `MCPSubscriptionResultMetaObject`, sweeping every consumer | mcp fix unit |
| MR10 | Subjective lane: `MCPClientTransportInterface` TSDoc is false of the server-bridge implementers | Accepted; document the shared role in the TSDoc; the interface rename is recorded as a decision in ROADMAP.md and not taken this wave | mcp fix unit |
| MR11 | Subjective lane: `MCPClient.on` is pure delegation to the exposed emitter (reproduced MCPClient.ts:252-257) | Accepted; delete the delegation, route consumers through the `emitter` property, and update the test call sites | mcp fix unit |
| MR12 | Subjective lane: `isFormElicitationSupported` and `isTaskSupported` are capability predicates misfiled in `validators.ts` | Accepted; move them to `helpers.ts` and update imports | mcp fix unit |
| MR13 | Subjective lane: the guide's transport interface row omits `duplex` | Accepted | mcp fix unit |
| MR14 | Subjective lane F1: dead README links; `README.md` absent from `ROOT_FILES` in tests/guides.test.ts | Accepted, convergent with MR3; fix the destinations and add `README.md` to `ROOT_FILES` so the gate reaches it | mcp fix unit |
| MR15 | Subjective lane F2: the README server example fails typecheck | Accepted, convergent with MR2 | mcp fix unit |
| MR16 | Subjective lane F3: the guide's map-size figures contradict each other | Accepted; reconcile to the measured value with its date | mcp fix unit |
| MR17 | Subjective lane F4: TSDoc first sentences use the bare imperative where the canon requires third-person `-s` form | Accepted; sweep authored TSDoc first sentences | mcp fix unit |
| MR18 | Subjective lane referral: `isBoundedJSON` allocation claim | Dropped on the record: the objective lane returned no such finding and no lane substantiated it | dropped |
