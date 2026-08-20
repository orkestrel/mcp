1. **BROKEN**

The packed matrix does not bind every defect its rows imply.

- The ordinary rows compare only `label`, `version`, `methods`, and `message` at `tests/distribution.test.ts:660`. The “15s deadline” row never observes the applied deadline. An implementation using `14_999`, a cap long enough for this peer, or no configured-deadline propagation can pass when the peer answers promptly.
- The pinned legacy rows use a peer that echoes `request.params.protocolVersion` at `tests/distribution.test.ts:76`. They cannot catch an implementation that accepts a different supported revision from a nonconforming peer. The pre-fix missing legacy-pin comparison could pass these rows.
- The pinned modern row uses a peer advertising every revision. It cannot catch acceptance when discovery omits the pin.
- The construction row is strong: it asserts construction phase, `-32022`, no outbound method, and no marker file at `tests/distribution.test.ts:675`.
- The red control is strong: it asserts connect phase, no version, exact `-32601` message, and only `server/discover` at `tests/distribution.test.ts:684`. A deadline failure would redden it.

Smallest fix: add packed peers that return a different supported legacy revision and omit a modern pin from discovery. Record the exact applied timeout or rename the 15s row so it does not claim deadline fidelity. Executing those mutations would demonstrate the failure counts, but source inspection already falsifies the universal claim.

2. **CONFIRMED**

The stdio and WebSocket controls bind the refusal split.

Both send a version-less legacy `initialize` and a well-formed modern-shaped `initialize`. They require exact `-32601` and `Method not found: initialize` answers at `tests/src/server/factories.test.ts:452` and `tests/src/server/factories.test.ts:688`. A generic `-32601` with another message also fails.

The pre-split dispatcher parsed metadata first and returned `-32602 Invalid params: malformed modern request metadata` for the version-less request. The retained baseline records both control tests red, while the supplied final server gate reports 264 passing tests. The attack using the pre-split answer therefore fails.

3. **BROKEN**

The flagship stdio instrument discriminates correctly, but the composition sweep missed the worker bootstrap.

`serveMCPScope` constructs a bare `MCPServer` and binds it directly at `src/browser/helpers.ts:179`. `ServeMCPOptions` exposes no dispatcher or legacy-composition seam. Yet the guide calls `serveMCP` a “drop-in entry” at `guides/mcp.md:3292` and says it exposes the registry to “every client” at `guides/mcp.md:3309`, without labeling the endpoint modern-only. A legacy `initialize` reaches the bare dispatcher and receives `-32601`, so this is another generally presented ingress outside the allowed contrast and signature citation.

The flagship fence itself holds: wrapped and bare dispatchers receive the identical `LEGACY_INITIALIZE` input and assert opposite full envelopes at `tests/guides.test.ts:869`. Its retained mutation reading reports one composed-row failure when the decorator was removed.

Smallest fix: label `serveMCP` and `serveMCPScope` modern-only in their TSDoc, surface table, guide prose, and examples, and direct dual-era users to the lower-level `bindServer(createMCPLegacy(...))` composition. An executed legacy worker probe was not supplied and cannot run without dependencies, but the source fixes the route conclusively.

4. **CONFIRMED**

Each micro-edit matches the landed code.

- The configured timeout becomes `#timeout` at `src/core/MCPClient.ts:224`, and `discover` passes it unchanged at `src/core/MCPClient.ts:308`. The deleted constant has no source or guide surface row.
- The bare-server paragraph matches the registry-first split at `src/core/MCPServer.ts:371`, and its guide transcription expects the registered-method declaration refusal.
- The duplex control’s `-32601` expectation at `tests/src/core/helpers.test.ts:676` matches the unregistered `initialize` path.
- The handlers example wraps the dispatcher. `inferHeaderIssue` admits headerless `initialize`, and `MCPLegacy` answers it, so its trailing comment is true.

The supplied core, server, and guide gate readings cover these paths.

5. **BROKEN**

Both tree-wide text claims are false, and the exit criterion is not closed.

- `DEFAULT_MCP_PROBE_TIMEOUT` remains in many tracked retained records, including `.orkestrel/mcp/handshake-reconciliation.md:20`, `.orkestrel/mcp/hs-u1-brief.md:20`, and `.orkestrel/mcp/fix-report.md:48`. It is absent from the product source and guide surface, not from the tree.
- `Invalid params: malformed modern request metadata` also remains in `guides/mcp.md:2543` and retained records, beyond the two implementation sites and their tests.
- The worker-bootstrap omission from claim 3 leaves example-era reach incomplete.
- The packed matrix gaps from claim 1 mean that matrix adequacy is not established, despite the supplied distribution gate reporting 2 passing tests.

Smallest fix: scope the text assertions to product-bearing or executable paths and explicitly allow retained historical records and the guide’s truthful malformed-grammar sentence. Close the `serveMCP` documentation gap and strengthen the packed pin rows before claiming wave-level closure.

VERDICT: FAIL