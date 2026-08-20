I held the **subjective lane** (shape, ergonomics, defaults, what the API feels like to a consumer who copies the examples). I read `AGENTS.md`, the named rule files, `guides/mcp.md`, the evidence under `/home/user/mcp/tmp/handshake-evidence/`, and the load-bearing source. I have no execution tools in this lane, so every claim below is either quoted from the evidence folder or derived from source that I cite by path and line, and I label which.

## Design

**The thesis.** All three defects are one design mistake wearing different clothes: this package makes era reach and negotiation patience the consumer's configuration problem, and then gives the consumer no signal when their configuration silently loses. A developer who copies the flagship example gets a server most MCP clients cannot talk to; a developer who sets a deadline gets a shorter deadline than the library's own default on the one request that decides the connection; a developer who names a revision gets a different one. Each failure is silent, and silence is the shared defect. The fix is to make the library's defaults correct, make each refusal name the thing that is actually wrong, and put a gate under every example that teaches a composition.

### Q1. Legacy reach belongs in the examples, made uniform and made mechanical

**Ruling.** Keep `createMCPLegacy` a decorator the consumer passes. Change every server-ingress example to compose it, and put the flagship stdio fence under the executed guide gate so the next example cannot drift back.

The doctrine is already right and already written: `guides/mcp.md:1561-1568` calls the decorator "a value you pass or do not pass" and states that a stdio deployment speaking the `initialize` handshake — "the most common shape an MCP server ships in" — wires as `createStdioServer(createMCPLegacy(mcp))`. What failed is application, not doctrine. The examples disagree with each other:

- `src/server/factories.ts:100` — `createMCPRoutes(createMCPLegacy(mcp)) // both eras; pass `mcp` for modern only`
- `src/server/handlers.ts:54` — `createMCPPostHandler(createMCPLegacy(mcp), { streaming: true })`
- `src/server/factories.ts:374-375` — `createStdioServer(mcp).start()`, no wrapper, no marker
- `src/server/factories.ts:207-208` — `createWebSocketServer(mcp, …)`, no wrapper, no marker
- `src/browser/factories.ts:118` — `bindServer(createMCPServer(…), …)`, no wrapper, no marker

A consumer copies the door they need, not the doorway that happens to carry the comment. The HTTP door teaches the composition and the stdio door — the one the guide itself names as the common shape — does not.

**Exact change.** In `src/server/factories.ts` (`createStdioServer`, `createWebSocketServer`), `src/server/middlewares.ts:88`, and `src/browser/factories.ts:118`, compose `createMCPLegacy(mcp)` and carry one identical trailing comment. Write that comment in client terms, not revision terms:

```ts
const mcp = createMCPServer({ identity: { name: 'docs', version: '1.0.0' }, tools: createToolManager() })
createStdioServer(createMCPLegacy(mcp)).start() // answers `initialize` too; pass `mcp` alone for modern-only
```

The revision dates are the wrong currency for a skim. `2025-11-25` reads as "old clients I do not have"; `initialize` reads as "the handshake my client sends." Naming the method is what makes the skim correct.

**What it preserves.** The removability claim in `guides/mcp.md:1532-1631`, the executed legacy-owning module set in `tests/guides.test.ts`, the requirement that `MCPServer.ts` carry no `legacy` spelling, and the narrow `MCPDispatcherInterface` every door accepts. No public symbol is added or removed.

**What it forecloses.** The measured failure in `tmp/handshake-evidence/mcp-drive.log`: a server built exactly from the shipped example refusing a legitimate `initialize`. It also forecloses the recurrence, because after this change the fence is transcribed and executed in `tests/guides.test.ts` per `.claude/rules/tests.md` § Cross-cutting proofs, so an example that stops answering `initialize` reddens a test rather than passing review.

### Q2. The probe deadline is the request deadline. `DEFAULT_MCP_PROBE_TIMEOUT` does not survive

**Ruling.** Delete the constant and the `#probe` field. `discover()` and the negotiation probe both carry `#timeout`.

- **The invariant.** An unpinned client against a modern-capable server negotiates `2026-07-28`, on a cold spawned transport and on a warm one, whether or not the caller configured `timeout`. Negotiation outcome does not depend on transport warm-up, and does not depend on an unrelated option.
- **The bound.** The legacy fallback still reaches a genuinely legacy-only peer within the caller's own `timeout`. A legacy-only peer answers an unknown `server/discover` with an error rather than with silence, so the fallback normally costs a round trip, not a deadline. Where a peer accepts the probe and never answers, the caller's own configured deadline is the correct bound, because it is the bound they asked for.
- **The derivation.** `options.timeout ?? DEFAULT_MCP_REQUEST_TIMEOUT`, with no floor, no cap, and no second constant.

**Why 50 fails on both sides.** The cap was written to make discovery cheap against a peer that does not speak it. It buys nothing there, because that peer answers with an error; and it costs the modern case its answer whenever the peer takes longer than 50ms to boot, which is every spawned stdio server. `tmp/handshake-evidence/tap-run.log:7` shows the server answering `supportedVersions` with all three revisions, validly, after the deadline had already fired.

**The shape defect underneath.** `src/core/types.ts:2222-2228` documents `timeout` as the per-request deadline. `src/core/MCPClient.ts:218-222` makes one configured number select three policies: the request deadline, the close-wait grace, and a probe cap that inverts the number's meaning. Setting 15_000 — shorter than the unconfigured 30_000 — moves the probe deadline from 30_000 to 50. A number whose value selects a different policy is a magic mode, which `.claude/rules/names.md` § Split behavioral variants refuses, and the drift it produces is exactly what "one concept, one term" exists to stop.

**Exact change.** Remove `DEFAULT_MCP_PROBE_TIMEOUT` from `src/core/constants.ts:183-184`; remove `readonly #probe` (`src/core/MCPClient.ts:129`), its assignment (`:219-222`), and its import (`:36`); pass `this.#timeout` at `src/core/MCPClient.ts:310`. Strike the cap clause from `src/core/types.ts:2481-2482` and from `guides/mcp.md:1702` and `guides/mcp.md:4141-4143`.

**What it preserves.** Every request still carries a deadline, still through `AbortSignal.timeout` and never a raw `setTimeout`. `discover()` as a public call is unchanged. The close-wait grace is unchanged. The public surface loses one exported constant, which is correct: the capability it named must not exist.

**What it forecloses.** Both timeout readings in the evidence — the unpinned silent downgrade to `2025-11-25` and the pinned outright failure at `[legacy-wrapped pin 2026-07-28 timeout 15s] FAILED: … timed out after 50ms`.

**The ergonomic half, with no new API.** An unpinned client that lands on a legacy revision reports that fact only through `client.version`. Do not add an event, an option, or a downgrade flag for it; the minimal-API law and the derive-state law both refuse a second signal for a fact `version` already carries. State it in the guide instead: an unpinned `connect` can land on a legacy revision, and pinning is how a caller refuses that.

### Q3. A pin is a refusal, not a preference

**Ruling.** `version` names the one revision the client speaks. An unsupported pin is refused at **construction**. A supported pin that the peer cannot serve fails `connect` and names what the peer offered. The client never negotiates a revision other than the one pinned.

**Refuse at construction, not at connect.** `.claude/rules/typescript.md` § Errors and outcomes fixes the rule: a programmer error or invalid argument throws. An unsupported pin is a configuration mistake, not an I/O outcome, so `connect` is the wrong place to learn about it — a static mistake surfacing as a connection failure sends the developer to the network and the server. `isMCPVersion` is already a total exported guard (`src/core/validators.ts:1218-1220`), so the check costs one call. The type already rejects the literal, so the callers who reach the runtime check are those crossing a JSON or `unknown` boundary — exactly the ones a construction-time throw serves best, at the point where the bad value entered.

**Exact change.** In the `MCPClient` constructor, after `this.#pin = options.version` (`src/core/MCPClient.ts:216`), throw an `MCPError` when `options.version !== undefined && !isMCPVersion(options.version)`, naming the value and `SUPPORTED_PROTOCOL_VERSIONS`.

**Second pin break, source-derived, not measured.** `src/core/MCPClient.ts:856-874` accepts any legacy revision the peer returns: `#initialize` checks `isMCPVersion(protocol) && inferEra(protocol) === 'legacy'` and never compares the answer against `#pin`. A client pinned to `2025-06-18` whose peer answers `2025-11-25` connects on `2025-11-25`. Add the comparison: when `#pin` is defined and `protocol !== this.#pin`, reject. I claim this inside the pin-fidelity capability Q3 names rather than as a rescope, because a pin that binds on the modern path and not the legacy path is not a pin.

**On the laws.** Absence-is-`undefined` already holds — an omitted `version` means negotiate. The defect is that a **present** value behaves like an absent one when unrecognized, which makes `'2020-01-01'` an accidental sentinel meaning "no pin." Refusing at construction is what reduces the option to its real states, present and absent. No `strict` boolean is added: a pin that does not bind is not a pin, so there is no second mode to name, and `version` plus `strict` is precisely the shape the boolean-behavior and real-domain-states laws refuse.

**Reading the bogus-pin control honestly.** `[control bogus 2020-01-01] negotiated=2025-11-25` in `tmp/handshake-evidence/README.md:26` was reached through the timeout path, not through a server refusal: derived from `src/core/MCPClient.ts:700-708`, the probe's 50ms timeout is not an `MCP_UNSUPPORTED_VERSION` error, so the fallback fires and `#initialize` is called with `MCP_PROTOCOL_VERSION`, discarding the pin. Fixing Q2 changes which door that row walks through; it does not close the defect, because the runtime still never validates the pin. Rule Q3 on the missing validation, not on the observed route.

**What it forecloses.** A client that reports a negotiated revision its caller did not ask for, on either era, and a configuration typo that survives to production as a working connection on the wrong wire.

### Q4. A legacy request at a modern-only dispatcher gets `-32601`, and the guide already says so

**Ruling.** `guides/mcp.md:1558` promises it: "modern only — a legacy request falls off the modern seam as `-32601`." The server does not deliver it. This is drift from the package's own documented behavior, not a new decision.

**The cause.** `parseRequestContext` returns `undefined` for facts that are not the same fact (`src/core/parsers.ts:119-125`): a request that carries no modern protocol-version key at all, and a request that carries one whose grammar fails. `MCPServer.#modern` (`src/core/MCPServer.ts:375-385`) reads that single `undefined` and names the second.

**Exact change.** In `MCPServer.#modern`, before `parseRequestContext`, branch on `isModernRequest(request)` — already exported from `src/core/validators.ts` and already imported by `MCPLegacy` (`src/core/MCPLegacy.ts:30`). Answer by fact:

- No version key, and the method is not registered on the modern seam → `-32601 Method not found: initialize`.
- No version key, and the method **is** registered → `-32602 Invalid params: request declares no protocol version`.
- Version key present, grammar fails → `-32602 Invalid params: malformed modern request metadata`, unchanged.
- Version key present, grammar passes, revision unsupported → `MCP_UNSUPPORTED_VERSION`, unchanged (`src/core/MCPServer.ts:386-393`).

The registered-method split matters: without it, a modern `tools/list` that forgot its `_meta` would be told the method does not exist, which is false and worse than today's message. The registry is already in hand at that point (`this.#methods.method(request.method)`).

**Keep the remedy out of the wire.** The message names the fact and stops. An error string advertising `createMCPLegacy` puts a factory name in front of a foreign client, which is product policy on a mechanism surface. The guide carries the remedy.

**What it preserves.** No era branch enters `MCPServer` — `isModernRequest` is a structural guard the modern engine already reads to decide what a request **is**, and `guides/mcp.md:1599-1605` explicitly keeps that class of read outside legacy ownership. `MCPServer.ts` gains no `legacy` spelling, so the executed module-set check in `tests/guides.test.ts` still passes.

**What it forecloses.** The measured refusal in `tmp/handshake-evidence/tap-run.log:6`. More importantly it forecloses the wasted debugging session: an operator reading `Method not found: initialize` reaches "my server does not answer `initialize`" in one step, where `malformed modern request metadata` sends them to inspect a client `_meta` that is correct and irrelevant. The wrong error costs more than the missing feature.

### Q5. Which tests bind the rulings

Placement per `.claude/rules/workspace.md` § Test project matrix and `.claude/rules/tests.md` § Cross-cutting proofs:

- **`tests/src/core/MCPClient.test.ts`** (`src:core`, Node) — construction refusal of an unsupported pin; the probe deadline equalling the configured `timeout`; `#initialize` refusing a negotiated revision other than the pin.
- **`tests/src/core/MCPServer.test.ts`** (`src:core`) — a bare `createMCPServer` answering a legacy `initialize` with `-32601`; a registered method missing its version key answering `-32602` naming the missing declaration; the malformed-grammar and unsupported-version answers unchanged.
- **`tests/integration.test.ts`** (`integration`, in `test`) — the drive matrix. Its subject is the handshake composed across the core client, the server stdio transports, and the core server, over a real spawned child process, which is "features work together end to end across environments." It packs nothing and drives no external service, so it does not belong in `distribution` or `service`; and it is not one module's proof, so it does not belong under `tests/src/server/`.
- **`tests/guides.test.ts`** (`guides`) — the flagship `createStdioServer` fence transcribed and executed, and parity failing on the removed `DEFAULT_MCP_PROBE_TIMEOUT` row until `guides/mcp.md:1702` and `guides/mcp.md:4141-4143` are corrected.

**The matrix needs a red row.** Every row in `tmp/handshake-evidence/mcp-drive.log` failed, so the instrument has never been shown to discriminate. Per `.claude/rules/quality.md` § Instruments, promote it with a control drawn from outside the population it covers: a client pinned to `2026-07-28` against a peer that serves no modern seam must fail, and must fail for the pin rather than for a deadline.

**One existing test is the instrument that hid this.** `tests/src/core/MCPClient.test.ts:1086-1093` asserts the literal source text of the constructor, including `Math.min(options.timeout, DEFAULT_MCP_PROBE_TIMEOUT)`. It reads a file rather than driving behavior, so it pinned the defect in place while reading as coverage. Replace it with a behavioral assertion on the deadline a configured client applies to its probe. Do not edit its string.

## Alternatives

**A1. Merge legacy into `createMCPServer` — the engine answers `initialize` natively.** Cost: it deletes the removability claim the guide argues across `guides/mcp.md:1532-1631`, puts an era branch inside `MCPServer`, and reddens the executed check that requires `MCPServer.ts` to carry no `legacy` spelling. It also makes the dated revisions permanent surface for every consumer who wants only the modern wire. The design wins because it gets the same consumer outcome — the copied example answers `initialize` — without spending the architecture that makes the legacy layer deletable, and because the executed guide fence is a cheaper guarantee than a code merge.

**A2. Wrap `createMCPLegacy` inside the transport factories, with `legacy: false` to opt out.** Cost: the transport layer starts constructing a core entity from a value the caller handed it; composition stops being idempotent, so the guide's own `createStdioServer(createMCPLegacy(mcp))` double-wraps; and the opt-out is a binary product-policy switch bolted onto a mechanism factory, which "Mechanism, not product policy" refuses. It also removes the consumer's ability to prove, by reading their own composition, which eras their server answers. The design wins because it keeps the decorator a value the consumer can see in their own code, and because the real complaint against A2's target — that nobody copies a default they cannot see — is answered by fixing the examples and gating them, not by hiding the choice.

## Units

Serialized in the main checkout, one writer at a time, in this order. Files are disjoint.

**U1 — Client negotiation and pin fidelity.** Role `sol` (`implementer`), engine **GPT-5.6 Sol**. `#negotiate` is a generation-guarded state machine with supersession and ownership invariants; this is the constraint-heavy, mechanical-precision class the routing table sends to Sol.
Owns `src/core/MCPClient.ts`, `src/core/constants.ts`, `src/core/types.ts`, `tests/src/core/MCPClient.test.ts`. Off-limits: `guides/mcp.md`, `src/core/MCPServer.ts`, `tests/integration.test.ts`, `tests/guides.test.ts`. Depends on nothing.
Acceptance, cheapest gate first:
1. `DEFAULT_MCP_PROBE_TIMEOUT` and `#probe` appear nowhere under `src/`.
2. `npm run lint:check` and `npm run check` pass.
3. A client constructed with a `version` outside `SUPPORTED_PROTOCOL_VERSIONS` throws `MCPError` from the constructor, proven with a value crossing an `unknown` boundary rather than a rejected literal.
4. A client with `timeout: 15_000` issues its negotiation probe under a 15_000ms deadline, asserted from the deadline the client applies, not from elapsed time.
5. `#initialize` rejects when the peer's `protocolVersion` differs from a defined `#pin`.
6. The source-text assertion at `tests/src/core/MCPClient.test.ts:1086-1093` is replaced by a behavioral assertion, not deleted.
7. `npx vitest --project src:core` green over the owned test file.

**U2 — Modern-seam refusal split.** Role `sol` (`implementer`), engine **GPT-5.6 Sol**. Fully ruled and objective; it changes published wire semantics, so it stays with Sol rather than `builder`.
Owns `src/core/MCPServer.ts`, `tests/src/core/MCPServer.test.ts`. Off-limits: `src/core/MCPLegacy.ts`, `src/core/parsers.ts`, `src/core/validators.ts`, `guides/mcp.md`. Depends on U1 (checkout serialization only).
Acceptance:
1. `npm run lint:check` and `npm run check` pass.
2. `MCPServer.ts` carries no `MCPLegacy` or `legacy` spelling.
3. A legacy `initialize` dispatched to a bare `createMCPServer` answers `-32601 Method not found: initialize`.
4. A `tools/list` with no `_meta` version key answers `-32602` naming the absent protocol-version declaration.
5. A request carrying the version key with failing grammar still answers `-32602 Invalid params: malformed modern request metadata`; a well-formed unsupported revision still answers `MCP_UNSUPPORTED_VERSION` with `supported` and `requested`.
6. `npx vitest --project src:core` green over the owned test file.

**U3 — Handshake drive matrix.** Role `implementer`, engine **Opus 5**, native. Routed away from Sol deliberately: this proof spawns a real child process and reads its pipes, and Bench laws rule "A bench sandbox spawns a child and denies that child's child" records that a child's stdio inside a bench exec is unmeasurable and fails as a **false green**. The Orchestrator takes the authoritative run on the host after the unit exits.
Owns `tests/integration.test.ts`. Off-limits: all `src/`, `guides/mcp.md`. Depends on U1 and U2.
Acceptance:
1. `npm run lint:check` and `npm run check` pass.
2. One table-driven case covers the cross product of composition (bare, `createMCPLegacy`-wrapped), pin (absent, each supported revision), and deadline (absent, configured), each row naming its expected negotiated revision or its expected failure.
3. Every wrapped row with a supported pin negotiates exactly that revision, with a deadline configured and without.
4. Every unpinned row against a modern-capable peer negotiates `2026-07-28`, on the cold spawned transport.
5. A control row outside that population reports failure: a client pinned to `2026-07-28` against a peer serving no modern seam fails for the pin, and the assertion names the pin rather than a deadline.
6. No row asserts on elapsed time.
7. The `.mjs` drive scripts under `tmp/handshake-evidence/` are not carried into the tree.
8. Report the `integration` project's own run with both readings; the Orchestrator takes the deciding run.

**U4 — Examples, guide, and parity.** Role `implementer`, engine **Opus 5**. Documentation voice and API-shape prose, which the routing table assigns to Opus. Runs last, so the prose is written against what shipped (`.claude/rules/documentation.md` § Parity).
Owns `src/server/factories.ts`, `src/server/middlewares.ts`, `src/server/handlers.ts`, `src/browser/factories.ts`, `guides/mcp.md`, `tests/guides.test.ts`. Off-limits: `src/core/**`, `tests/integration.test.ts`. Depends on U2 and U3.
Acceptance:
1. `npm run format:check` and `npm run lint:check` pass.
2. Every server-ingress example composes `createMCPLegacy(mcp)` and carries the identical trailing comment naming `initialize` and the modern-only subtraction.
3. `guides/mcp.md` carries no `DEFAULT_MCP_PROBE_TIMEOUT` row and no probe-cap clause, at the constants table and at the client contract section.
4. The guide states the pin contract — construction refusal, `connect` failure when the peer cannot serve the pin — and states that an unpinned `connect` can land on a legacy revision.
5. The guide states the connect worst case with the cap removed: a peer that accepts the probe and never answers costs the configured deadline before the fallback, and the fallback carries its own.
6. `tests/guides.test.ts` transcribes and executes the `createStdioServer` fence and asserts that the composed server answers `initialize`.
7. `npx vitest --project guides` green.

**Exit criterion.** The campaign ends when each capability closes: flagship-example era reach (implemented, U4, gated by U3 and the guide fence), probe-deadline law (implemented, U1), pin fidelity across both eras (implemented, U1), modern-seam refusal vocabulary (implemented, U2), and the drive matrix retained as a gated regression instrument with a red control (implemented, U3).

## Tensions

Named for the objective lane to challenge, or for the Orchestrator to rule.

- **T1. Construction-time pin refusal.** I chose the constructor over `connect`. The objective lane can hold that `MCPClient` reports every other protocol fault from `connect` as `MCPError`, that a throwing constructor is hostile inside a factory chain, and that `createMCPClient` returning an unusable object is the lesser surprise. I reject that trade because it converts a static mistake into a network symptom, but the placement is a judgment call and it is the one I would expect to lose first.
- **T2. Deleting `DEFAULT_MCP_PROBE_TIMEOUT` outright.** The reachable compromise is a floor — `Math.max(options.timeout, 2_000)` — which bounds the fallback for a silent peer. I refuse it: a floor re-creates a second policy on one number and re-opens the same class of surprise at a different threshold. If the objective lane produces a real peer that accepts `server/discover` and never answers, this ruling needs re-taking.
- **T3. Examples plus a gate, rather than a factory default.** The strongest counter is that a default nobody copies is not a default, and that an executed fence proves the example rather than the deployment. I hold that a visible composition is worth more than an invisible one, but the Orchestrator owns whether "the consumer must type one more call" is acceptable for the package's most common shape.
- **T4. The registered-method split inside Q4.** The simpler form answers `-32601` for every non-modern request. I chose the finer form because the simpler one tells a caller that `tools/list` does not exist. The objective lane can argue that reading the registry before validating metadata inverts an ordering the dispatcher relies on; I did not verify that ordering by running it.
- **T5. `#initialize` refusing a peer-chosen legacy revision.** This behavior change is not among the three enumerated defects. I claim it inside the pin-fidelity capability rather than as a rescope. The Orchestrator rules whether it lands in this change or in the next.
- **T6. The matrix in `integration` rather than `src:server`.** I read the subject as cross-environment composition. The objective lane can hold that the stdio transports own it and that `tests/src/server/` is the mirrored location.
- **T7. No new signal for a silent downgrade.** I refused an event, an option, and a flag, leaving `client.version` and the guide. Someone will argue a consumer cannot notice a downgrade without a signal.

## Risks

- **R1. The example edits move the published artifact.** These examples are TSDoc, so they ride into `dist/` declarations. Under the release-wave rule a material dist diff obliges a bump, and `@orkestrel/mcp` 0.0.20 is being prepared. Evidence needed: rebuild after U4 and run the material-dist comparison against the published 0.0.19 tarball, so the bump trigger is read from the build rather than from the source diff.
- **R2. Removing the cap lengthens the worst case for a peer that swallows unknown methods.** My bound argument rests on the belief that a legacy-only MCP server answers an unknown `server/discover` with a JSON-RPC error rather than with silence. I did not verify it. Evidence needed: bounded primary-source research over the reference server implementations' unknown-method behavior, routed to `grok`. If a real implementation goes silent, T2's floor comes back into play and this ruling is re-taken.
- **R3. Cold-start timing flakiness in `integration`.** A matrix that spawns a child and asserts a negotiated revision is sound; one that asserts an interval is not. Evidence needed: the deciding run taken by the Orchestrator on an idle host after U3 exits, per the rule that a unit's own timing reading is systematically pessimistic.
- **R4. `MCPLegacy` composed twice.** After U4 every example shows the wrapper; a consumer following both a factory example and the guide's legacy section could write `createMCPLegacy(createMCPLegacy(mcp))`. Evidence needed: drive the double-wrapped composition once and record what it answers. Derived from `src/core/MCPLegacy.ts:74-81`, the outer decorator forwards a modern request and translates a legacy one, so the inner one receives a translated modern invocation and passes it through — likely benign, and I did not run it.
- **R5. Out-of-scope finding, recorded against the capability that owns it.** `src/core/MCPClient.ts:856-865` sends `capabilities: {}` in the legacy `initialize` handshake and never reads `this.#capabilities`, so a client's declared capabilities reach a modern peer and not a legacy one. That belongs to the client-capability capability, not to this change. Do not reopen this scope for it.

LANE COMPLETE
