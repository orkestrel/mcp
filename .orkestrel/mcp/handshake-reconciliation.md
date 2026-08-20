# Handshake design reconciliation

The subjective lane (Opus 5 `planner`, native) and the objective lane (GPT-5.6 Sol `analyst`,
journal `tmp/codex/handshake-analyst-journal.jsonl`, session `01a02140-d289-72f1-bd3d-1eb61ed34261`)
ran blind on `tmp/handshake-design-brief.md`, 2026-08-20. The Orchestrator reconciles here; the
lanes' full answers ride beside this file.

## Convergences, adopted

- **Q1.** Legacy reach stays in the explicit `createMCPLegacy` decorator. Runtime defaults do not
  change. Every example that claims a generally usable MCP endpoint composes
  `createMCPLegacy(mcp)` with one identical trailing comment naming `initialize` and the
  modern-only subtraction; one adjacent bare example stays, labeled modern-only. The objective
  lane's constraint kills auto-wrapping conclusively: the transport factories accept
  `MCPDispatcherInterface` while `createMCPLegacy` requires `MCPServerInterface`
  (`src/core/factories.ts:67`, verified). Sites: the union of both lanes' lists — the stdio,
  WebSocket, session-middleware, and browser `bindServer` examples, the guide's HTTP, WebSocket,
  stdio, and session sections, and the README headline example. The WebSocket prose's
  `initialize` claim corrects to modern discovery.
- **Q2.** `DEFAULT_MCP_PROBE_TIMEOUT` and the `#probe` field are deleted. The discovery probe
  carries `options.timeout ?? DEFAULT_MCP_REQUEST_TIMEOUT` — no floor, no cap, no second
  constant, no alias. Both lanes reached this independently. The fallback bound for a silent peer
  is the caller's own deadline; an explicit `-32601` from a legacy peer triggers fallback
  immediately.
- **Q3.** A pin is an exact constraint. A runtime `version` outside `isMCPVersion`
  (`src/core/validators.ts:1218`, verified) throws `MCPError` with `MCP_UNSUPPORTED_VERSION`
  (`-32022`) synchronously in the constructor, before the emitter and transport subscription,
  with `{ supported: SUPPORTED_PROTOCOL_VERSIONS, requested }` context. A modern pin succeeds
  only when discovery advertises exactly that revision; a legacy pin succeeds only when the
  `initialize` reply's `protocolVersion` equals it, compared before `notifications/initialized`
  and before connection state installs. Both lanes independently found the legacy-path pin gap at
  `MCPClient.ts:856-874`. No `strict` boolean. The planner's T5 hesitation is overruled: the
  legacy comparison is inside the pin-fidelity capability, not a rescope.
- **Q5, instruments.** The source-text assertions over `#probe` and `Math.min` in
  `tests/src/core/MCPClient.test.ts` are replaced with behavioral assertions — both lanes named
  this test as the instrument that pinned the defect in place while reading as coverage.

## Divergences, ruled

- **Q4, the refusal split.** Adopted: the structural check first, then the registry split. In
  `MCPServer.#modern`, before `parseRequestContext`: a request with no modern version key whose
  method the modern seam does not register answers `-32601 Method not found: <method>`; one whose
  method IS registered answers `-32602 Invalid params: request declares no protocol version`. A
  present version key with failing grammar keeps `-32602 malformed modern request metadata`; a
  well-formed unsupported revision keeps `MCP_UNSUPPORTED_VERSION`. The subjective lane's split
  is adopted over the objective lane's flat `-32601` because a bare `-32601` for a registered
  `tools/list` states a falsehood; the objective lane's structural-first ordering is adopted as
  the guard. The registry read is side-effect-free; the writer verifies the ordering inverts no
  dispatcher invariant and stops per the deviation contract if it does.
- **Q5, matrix placement.** Adopted by subject, per `.claude/rules/workspace.md`: the core
  behavioral proofs in `tests/src/core/` (`src:core`); the source-level spawned stdio control
  extended in `tests/src/server/factories.test.ts` (`src:server`); the packed-artifact handshake
  matrix in `tests/distribution.test.ts` (`distribution`, from `prepublishOnly`) — the objective
  lane's placement, because the matrix packs and installs, which `integration` refuses. The
  subjective lane's red control joins the matrix: a client pinned to `2026-07-28` against a peer
  serving no modern seam fails for the pin, and the assertion names the pin rather than a
  deadline.

## Orchestrator measurements folded in

- **Double-wrap.** `createStdioServer(createMCPLegacy(createMCPLegacy(mcp)))`, driven in JS:
  modern negotiation still lands `2026-07-28`, and a pinned legacy `initialize` is swallowed
  silently (timed out at the caller's full deadline). TypeScript refuses the composition — the
  outer call receives `MCPDispatcherInterface`, not `MCPServerInterface` — so the type system is
  the guard, no code changes, and no example or guide sentence teaches the misuse.
- **Reference-server unknown-method behavior**, resolved 2026-08-20: the Grok lane went dark on
  this question (recorded, killed by process id) and the native researcher closed it — neither
  reference SDK's legacy server exits or goes silent on a pre-initialize unknown method; the
  TypeScript server answers `-32601` and the Python server answers `-32602`, and the client's
  fallback fires on any discover failure short of `MCP_UNSUPPORTED_VERSION`, so the Q2 ruling
  stands corroborated with silence bounded by the caller's own deadline. The cited record rides
  in `handshake-research-servers.md`.

## Findings recorded outside this scope

- The client sends `capabilities: {}` on the legacy `initialize` and never reads
  `this.#capabilities` (`MCPClient.ts:856-865`, the subjective lane's R5). Recorded against the
  client-capability capability for a successor change.

## Routing ledger

| Unit | Subject | Role | Engine |
| ---- | ------- | ---- | ------ |
| U1 | Client negotiation and pin fidelity | `sol` | GPT-5.6 Sol |
| U2 | Modern-seam refusal split | `sol` | GPT-5.6 Sol |
| U3 | Handshake matrix proofs (spawned + packed) | `implementer` | Opus 5, native — a bench cannot measure a spawned child's pipes |
| U4 | Examples, guide, README, and the executed fence | `implementer` | Opus 5 |

Serialized in the main checkout in that order, each from a committed baseline. U1 and U2 are
bench-safe: their proofs are in-process.

## Exit criterion

The handshake pass closes when each capability ends implemented and gated: example-era reach with
the executed flagship fence; the probe-deadline law with no cap spelling anywhere; pin fidelity on
both eras with the construction refusal; the modern-seam refusal vocabulary; and the drive matrix
retained as a gated regression instrument with its red control. Acceptance takes the gate chain
green plus the material-dist comparison already obliged by the 0.0.20 bump.
