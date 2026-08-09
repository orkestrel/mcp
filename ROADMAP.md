# MCP 2026-07-28 enterprise-hardening roadmap

## Dated objective and authority

Status date: **2026-08-07**. Package: `@orkestrel/mcp@0.0.12`. Branch: `main`. Intake and
current HEAD at this checkpoint: `8d77e14fddc80d53b427d37440d301d570374cc1`.

The objective is a publishable, enterprise-grade MCP package whose canonical implementation follows
the latest official protocol, while a thin removable translation layer supports the legacy
initialize/session/GET-SSE era. The last verified official protocol authority is MCP `2026-07-28`.

**Reverified 2026-08-08 against primary source** — `2026-07-28` is still the current dated revision
(spec site, release blog, and `schema/2026-07-28/schema.ts` in the specification repository); no newer
revision exists. Five gating answers, each quoted from the schema or spec prose:

1. **Error-response id is OPTIONAL, never `null`.** `JSONRPCErrorResponse.id?: RequestId`, and
   `RequestId` is `string | number`. MCP **overrides** JSON-RPC 2.0 §5 here: the id is omitted when a
   malformed request makes it unreadable, not set to `Null`. Today's
   `buildJSONRPCResult`/`buildJSONRPCError` type it `string | number | null` and emit `id: null` —
   JSON-RPC-conformant but **not** conformant to this revision.
2. **`resultType` is required on every result.** "The `result` MUST include a `resultType` field."
   `Result` carries `resultType: ResultType` plus `_meta?` and an open index signature. Values include
   `complete`, `input_required`, and extension values such as `task`.
3. **The `subscriptions/listen` filter keys are spec-fixed**, nested under `params.notifications`:
   `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`. They are
   external wire spellings, not package-authored option keys.
4. **A notification is a distinct type with no `id` field**, not a request with an optional id.
   "Notifications MUST NOT include an ID."
5. **Tasks is an opt-in extension**, negotiated via the `io.modelcontextprotocol/tasks` capability and
   specified in a separate repository — not core. Methods: `tasks/get`, `tasks/update`, `tasks/cancel`;
   `CreateTaskResult` carries `resultType: "task"`; statuses `working | input_required | completed |
failed | cancelled`; optional push via `notifications/tasks` through `subscriptions/listen`.

This file is the sequenced plan of record. A later row does not start while an earlier row is
non-green. The thread goal service may still display an old `blocked` state from the completed Guide
publication pause; the user's resume instruction and this roadmap make the MCP campaign active.

Authority, in order:

1. The user's current instruction.
2. [`AGENTS.md`](AGENTS.md) and every applicable file under [`.claude/rules/`](.claude/rules/).
3. The [`orkestrel-harden-package`](.agents/skills/orkestrel-harden-package/SKILL.md) workflow and
   its required references.
4. The reverified dated official [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28),
   schema, and final [Tasks SEP](https://modelcontextprotocol.io/seps/2663-tasks-extension), plus
   the exact negotiated extension artifact.
5. [`guides/README.md`](guides/README.md), [`guides/src/mcp.md`](guides/src/mcp.md), authoritative
   `*/types.ts` files, public barrels, and installed dependency declarations.
6. This roadmap and the latest root reconciliation named by the applicable row. A later root
   reconciliation supersedes conflicting proposals.
7. Live code and tests as evidence to verify, not authority merely because they already exist.
8. Independent non-writer acceptance evidence. Writer reports and green commands alone do not
   accept a unit.

Research uses Cursor Grok model **`cursor-grok-4.5-high`** for read-only absorption and distillation
only. Grok does not own design, implementation, or acceptance. If that exact bridge is unavailable,
record the failure and use a clearly labeled primary-source researcher/scout fallback. The latest
attempt, [`97a-grok-successor-distillation-report.md`](tmp/mcp-hardening-20260807/97a-grok-successor-distillation-report.md),
is a transparent non-result because the model environment was unavailable; it is not research
evidence. Objective decisions remain Sol-led, with an independent Sol design-fit/adversarial pass
standing in for the unavailable Claude model.

## Terminal architecture

- The package supports both protocol eras, but has one source of truth. The canonical `MCPServer`
  and `MCPClient` are modern, host-independent, and stateless across requests. Every modern request
  carries its protocol version, client identity, and relevant capabilities. State crosses requests
  only through explicit opaque continuation, Task, resource, or application-owned handles.
- Request progress, multi-round-trip requests (MRTR), Tasks, and subscriptions stay distinct.
  Progress is request-scoped, backpressured, non-durable, and non-replayable. MRTR resumes a new
  request through integrity-protected opaque `requestState`. Tasks are durable operations whose
  authoritative recovery snapshot comes from `tasks/get`. Subscriptions are event-driven full
  snapshot projections for latency, never durable truth, replay, or Task-progress streams.
- A consumer-supplied Task provider owns authorization on every operation, atomic idempotent
  creation, persistence and queue/outbox boundaries, retry-safe execution, updates, cancellation
  intent, events, retention, and expiry. Creation deduplicates on a stable application operation
  key, not a JSON-RPC request ID. MCP supplies no default store, `tasks/list`, or implicit polling
  loop.
- Legacy `initialize`/`initialized`, `Mcp-Session-Id`, session deletion, GET-SSE,
  `Last-Event-ID`, and replay live in one thin removable translator over the same modern
  execution/Task backend. It owns no second tool engine, validator, MRTR state, Task store, or
  pseudo-Tasks. Outcomes the old protocol cannot represent fail closed.
- Core receives no raw HTTP policy. Transports own exact headers, incremental SSE, backpressure,
  disconnect cancellation, and host drain while reusing centralized protocol mechanisms.
- `tool`, `workflow`, `toolbox`, `supervisor`, and WebStorm are proof and migration consumers, not
  MCP dependencies or policy authorities. Their progress, abort, and task contexts are integration
  evidence; MCP remains transport-neutral. Current real-service probes may use
  `http://127.0.0.1:64542/sse` and `http://127.0.0.1:64542/stream` when that neighboring service is
  running.
- Public API names follow the repository's single-word entity rule. Compound external spellings
  remain only where the MCP specification, HTTP, or a vendor wire contract requires them. W01 and
  every later types-first unit audit property, method, option, event, header, and export names
  explicitly rather than inheriting current names.
- Consumer evidence gates adding or expanding a capability. Once an intentional reusable
  capability exists, it is public through its owning barrel regardless of consumer count; every
  developer receives the same mechanism and customization surface. The current intentional public
  declarations are `snapshotJSON`, `snapshotToolResult`, `MCPProgressReporter`, and
  `HTTPDisconnect`. `buildCallResult` remains deliberately absent. `normalizeLegacyJSON` remains in
  the centralized helpers file rather than a standalone implementation file.

## Acceptance bar (revised 2026-08-08, user-directed)

The prior bar was "no adversary can break any claim". That is unbounded by construction — there is
always another interleaving — and it cost roughly 46 review/fix rounds across rows 2-4 while rows 5-10
did not start. Rows 2-4 were repair of substrate that already worked; rows 5-8 are the unbuilt
architecture. The bar below replaces it.

**A unit is accepted when all five hold, and not when no one can break it:**

1. A red→green proof is recorded for every defect fixed: exact command, failing count, smallest fix,
   identical command green.
2. **One** audit round returns no defect reachable through this package's own shipped code or its
   documented extension seams. One round, not N.
3. The five gates pass in order: `format:check → lint:check → check → build → test`.
4. Guide parity holds and no shipped sentence is false.
5. No TODO, skipped test, or deferral inside the unit's scope.

**The rule that ends the spiral:** a defect reachable only by a hypothetical third-party
implementation is **documented as a contract obligation, not fixed**. Round 4 reached this conclusion
on its own evidence — three TSDoc sentences on `ClientTransportInterface` retire more risk than any
refactor inside `MCPClient`, because six mechanisms there were enforcing, from one side, invariants the
transport contract never stated.

Aim: accuracy and reasonable performance, good enough for production. Not the best that has ever been.

**Scope decision, user-directed 2026-08-08:** rows 5-8 are built **in full**, including Tasks,
subscriptions, and the S00/L01 carrier redesign. The package is prepared publish-ready and **not**
published; publication remains the user's action.

### Coverage, not optimization (user-directed 2026-08-08)

Rows 5-8 are graded on **coverage** — does every capability exist, work, and stay proven — not on
**optimization**, which is how many further interleavings an adversary can invent against one seam.
Enterprise-grade and production-ready remain the target; the target is breadth of correct, proven
capability, not depth of polish on a single surface.

**Every unit in rows 5-8 opens with a capability matrix**, per the `AGENTS.md` research law, written
to its brief file **before** implementation. It enumerates, from the dated spec and the terminal
architecture above, every capability the unit owns. Each row ends as **implement**, **repair**,
**retain**, or **intentionally exclude with evidence** — no row ends as "hardened further".

**A unit is done when its matrix is complete and its five bar conditions hold.** The matrix is the
definition of done and it is fixed at the unit's start; discovering a new adversarial interleaving in
an already-covered row does not reopen the unit. It is recorded as a deferred defect against the row
that owns it, exactly as D1-D3 were, and the unit still closes.

**The stop rule.** When a unit's matrix is green, stop and move to the next unit. Depth work beyond
the matrix requires a new user instruction, not an auditor's appetite.

### Standing design ruling — exchange ownership (W02 escalation, 2026-08-08)

The escalation budget fired at W02 round 2: **three defects at one seam** — row 41 (cancellation
stuck behind a producer's queue), round 1's subscription-slot leak (same class, different resource),
and round 2's pump abandonment (same seam, **opposite** mechanism — cancellation is not blocked, it
is never issued). Every repair had answered _"route the release onto another signal"_, and that
answer failed at the third place because **no signal fires when nobody aborts anything**.

**Ruling, binding on W05 and every later consumer:** ending a controlled exchange is the obligation
of whoever is handed it, **on every exit — including the exits where nothing was cancelled.**

`MCPStreamController` already implements `[Symbol.asyncDispose]`; **neither shipped pump uses it.**
The obligation is stated on `MCPStreamControllerInterface` / `MCPTextStreamControllerInterface`, and
both pumps (`sendStream`, and `createMCPPostHandler`'s SSE pump) adopt `await using`. `sendStream`
narrows its first parameter to the controller interface `bindServer` already passes.
`HTTPDisconnect.#stop()` aborts `#lifecycle` rather than `#abort`, leaving the composed signal live
on the failure path — the same ruling fixes it.

Do **not** patch one pump in isolation, and do **not** give the controller an owner of last resort
that silently ends exchanges nobody released — that hides the missing obligation instead of stating
it. The guide already documents the correct pattern at `mcp.md:388-395`, which is what proves the
obligation was always intended.

### Standing design ruling — revocation is the fifth exit (W05/W06 escalation, 2026-08-08)

The budget fired a second time at the same seam, and the fourth defect arrived by a mechanism the
first ruling did not model. The first three were all _"a party who was handed an exchange failed to
end it."_ This one is different: **the release existed, was correct, and a second party withdrew it
before it could run.**

`bindServer` registers `transport.closed(…)` to abort its live registry, and the `unbind` it returns
replaces **both** handlers — including `closed`. So after `unbind()`, closing the transport ends
nothing, ever. `bindServer`'s own TSDoc tells callers the opposite (_"a caller that wants them ended
closes the transport"_), and `src/browser/helpers.ts:138-141` — **shipped code**, `serveMCPScope`'s
teardown — registers exactly the losing order: `unbind()` then `transport.close()`. Disposing a
worker scope, the one moment every in-flight exchange must end, is precisely when none of them do.

**Ruling, binding on every API in this package that hands out a detach:** a detach is an **exit**,
and the first ruling applies to it unchanged. `unbind()` discharges what the binding owns — it aborts
the live registry exactly as `closed` does — so that **both orders end everything and neither order
is a caller obligation.**

Reject the two alternatives on the record. _Swapping the two statements in `src/browser/helpers.ts`_
closes this instance and leaves the model untouched: the next caller who writes the natural order
reproduces it, with the TSDoc still recommending it. _Making `closed` a subscription the detach
cannot overwrite_ requires changing `MCPTransportInterface` from an assignable handler to a
subscription — a larger API change that still never answers who ends the exchanges.

The generalization is the point: **an exit is any transition after which the exchange's owner will
not act again** — completion, failure, cancellation, close, and now **revocation**. A release that a
second party can withdraw is not a release. Order-independence is asserted as a test in both
directions, so a sixth spelling cannot reintroduce the class silently.

### Standing design ruling — an instrument's stated rule is its contract (W05/W06, 2026-08-08)

The same round produced a second, independent escalation, and it is about **evidence** rather than
lifecycle. Two instruments this campaign relies on were found describing themselves inaccurately:

- The browser containment sweep states a membership rule covering _"a `next`/`return`/`throw` call"_
  and _"a computed member spelling either"_, but matches only `ts.isPropertyAccessExpression` — so
  `source["next"]()`, destructuring, aliasing, and `Reflect.get` all pass while reading as covered.
  Seven smuggled second pumps were all invisible. The recorded blind spot names a **narrower** hole
  than the one that exists.
- `scripts/conformance.mjs` constructs `createMCPServer({ identity, tools })` **without
  `execution`** — the shipped, documented port. Wiring it takes the result from **8/15 to 13/10**
  with zero changes to `src/` or `dist/`. The guide's stated reason for those failures (_"need
  Resources and Prompts to be reachable first"_) is false, and five of the fifteen fall into none of
  its seven declared categories.

  **Settled at 13/10, not the 12/11 first measured.** The audit lane wired a two-frame executor;
  `tools-call-with-progress` **specifies three** and counts them, so its failure was a _second_
  fixture under-report rather than a library gap — the library delivered both frames the fixture
  emitted, in order, with the correct token and an intact result. The remaining ten are exactly
  Resources (4), Prompts (5) and `completion/complete` (1): **every one a declared non-goal, with no
  gap category left dangling.** The instrument understated this package by **five** scenarios, not
  four, and W08 records 13/10 as the honest baseline.

**Ruling:** an instrument's stated membership rule is a claim about the instrument, and a gap between
what it says and what it matches is a **defect in the instrument**, not a documented limit. A
recorded blind spot buys trust only when everything outside it is genuinely covered; a reader who
relies on a clause that does not fire is worse off than one who had no clause. Likewise a recorded
baseline must measure **the product, not the harness** — a number quoted as evidence about this
package while measuring a fixture omission is a credibility defect, and it understated this package
by four scenarios. Neither is a publication blocker; both are corrected before publication, because
the numbers are quoted in the guide.

## Real IDE interop: JetBrains WebStorm (user-directed, 2026-08-09)

The user supplied a live IDE MCP server — **WebStorm 2026.2.0.1** at `http://127.0.0.1:64542` — and
asked for both directions. This is the real foreign-client evidence W08 could only decline to claim.

**What the endpoints are.** `/stream` is Streamable HTTP speaking the **`2025-06-18`** handshake — this
package's legacy era. `/sse` is the older **2024-11-05 two-endpoint transport** (GET opens the stream
and advertises `/message?sessionId=…`; POST to `/sse` returns **405**), which this package does not
implement and does not claim.

**Client direction — two defects found, both reachable by `createMCPClient({ transport })`, the most
obvious construction there is.**

| Endpoint  | Peer's answer                       | Before           | After                               |
| --------- | ----------------------------------- | ---------------- | ----------------------------------- |
| `/stream` | JSON-RPC error carrying **no `id`** | **hung forever** | **connects in 39-53 ms**            |
| `/sse`    | **HTTP 405, no MCP body at all**    | **hung forever** | rejects in ~60 s naming the timeout |

1. **An id-less error response was silently dropped.** The transport parsed and emitted it correctly —
   measured byte-identical from WebStorm and from a local fixture — but the client correlates replies
   by `id`, so it matched no pending request. **Ruling:** per JSON-RPC 2.0 §5 that shape reports the
   peer could not attribute a request, so no pending request can be assumed safe; it now **rejects
   every pending request**, carrying the peer's own code and message.
2. **The discovery probe carried no deadline when `timeout` was unconfigured** — documented at
   `MCPClient.ts:96-99` as deliberate. `/sse` proved no correlation fix can ever reach the second
   shape, because a 405 with no MCP body is not a message. **Ruling:** the probe always bounds itself,
   using `DEFAULT_MCP_REQUEST_TIMEOUT` (30 s) when unconfigured — **not** the 50 ms configured probe,
   which would silently mis-route a slow modern peer to the legacy handshake. `#probe` is now
   non-optional, so TypeScript enforces it.

Verified against WebStorm itself, not only the fixtures: connect **45 ms**, `tools()` returning **43
real WebStorm tools**, and an unknown tool erroring with the peer's own message.

**Server direction.** This package's server, driven by a client speaking WebStorm's dialect:
`initialize` → 200 negotiating `2025-06-18`; `notifications/initialized` → 202; `tools/list` → 200
with the tool and its schema; `tools/call` → 200 with `content` and `structuredContent`. **Stated
honestly: this is a protocol-faithful stand-in, not WebStorm's own client**, because the IDE cannot be
pointed at us from here. `quality.md`'s law is unchanged — that direction remains unproven by a real
foreign client.

**No repository test touches `127.0.0.1:64542`.** Both regressions drive real local `node:http` peers,
so the suite runs identically where no IDE exists. The sandbox lives in `tmp/webstorm-sandbox/`.

**Observation, not a defect:** when the `MCP-Protocol-Version` header is missing, the server answers
`-32020` naming `2025-11-25` — its own offer — rather than a negotiated version. Without the session
middleware mounted the server is stateless and cannot know what was negotiated, so naming its offer is
correct.

**Orchestrator error worth keeping.** A logging reverse proxy produced a **false diagnosis** — "the
legacy fallback never fires" — that evaporated the moment the proxy left the path. The proxy was
breaking the flow it was installed to observe. An instrument that lies is worse than no instrument,
and the rule that caught it is the one saying a clean reproduction means your vector differs, not that
the finding is wrong.

## Tests-folder cleanup and its audit (2026-08-09)

Six files moved their assertions to the file mirroring each subject and were deleted:
`resources.test.ts`, `prompts.test.ts`, `types.test.ts`, `errors.test.ts`, `serve.test.ts`,
`fixtures/hostilePeer.ts`. Every item cited a line of `.claude/rules/tests.md` — mirroring, the
forbidden-subject rule for error definitions, the duplicate-helper rule, setup-file placement.

**The audit earned its cost, and the two lanes disagreed usefully.** The objective lane read the
matchers and found `toEqual` had become **`toMatchObject`** in a moved reply proof. The subjective
lane ran an assertion census — 136 `expect(` before, 136 after — and concluded no matcher changed.
**A count cannot see matcher strength.** The Orchestrator verified the source and the objective lane
carried. Each lane also found breaks the other missed: the census lane caught an invented `record`
option (37 call sites, none passing `false`), a `close()` that had silently gained `onClosed?.()` and
become synonymous with `signalClosed`, three type assertions filed in a third file, and
`inspectFloorSyntax` sitting with **zero consumers** — the last residue of the deleted scanner suite.

**Three standing lessons, all Orchestrator errors:**

- **Never delete an untracked file without snapshotting it first.** Three of the six were untracked,
  so `git show` could not reach them and the audit's prescribed instrument could not have worked. The
  originals survived only inside the writer's Codex journal.
- **Capture every unit's report to disk beside its brief**, as the bench contract requires. Skipping
  it is why the recovery above was necessary at all. Reports are now captured.
- **A scope boundary can cause the break it was meant to prevent.** Marking `guides/**` off-limits
  left two guide links pointing at deleted test files; the writer correctly reported the parity break
  rather than reaching outside its scope, and the Orchestrator repaired it.

Fix round C closed all of it: exact matcher restored (and the sweep found no second softened one),
the one-state option deleted, `close()` made the sole closure verb, the type assertions colocated with
their runtime counterparts, the **erased-at-runtime** warning restored so 57 `expectTypeOf`
assertions are not mistaken for suite-checked, names and browser-fixture placement repaired, and the
dead scanner deleted with nothing put in its place.

**Terminal:** `test:src` **1,001** across 27 files, `test:policy` **5**, `test:guides` **121**,
`check` 0, `lint:check` 0, `format:check` 0, `build` 0, conformance **23/0**. Custody unchanged.

**Recorded, not acted on:** `tests/setup.ts` is 1,512 lines with 50+ exports. It is shared
infrastructure that has grown into "everything shared". Restructuring it is a separate scope, not a
tail added to a cleanup.

## Ruling — the architecture tests are deleted (user-directed, 2026-08-09)

`tests/architecture.test.ts` and `tests/setupArchitecture.ts` are **deleted**, along with every MCP
structural law they carried. The user's judgment, and it is correct on three counts.

**They violated `AGENTS.md` outright.** _"Do not add a second parser or source-language analyzer to
duplicate TypeScript, Oxlint, Vue, HTML, CSS, or Vite."_ They imported the TypeScript compiler API
and walked the AST to enforce structure. That is exactly a second source-language analyzer.

**They broke `tests.md`'s central rule** — _"test observable behavior, not implementation details."_
Every law asserted shape.

**They were mostly instrument, not subject.** 1,838 lines producing 34 tests, of which roughly six
asserted anything about the package. The rest proved the scanner's own controls valid or recorded
what the scanner could not see: _"proves the smuggled engine uses none of the spellings the previous
rule enumerated"_, _"records the pump shapes the structural rule cannot reach"_.

**And the instrument failed at its own job.** The legacy-removability law declared the surface was
seven modules. The adversarial audit found `MCPLegacyOptions` orphaned outside it **and**
`MCPClient` still a working legacy engine. It gave confidence about precisely the thing it existed
to guard.

**Origin, stated plainly:** each law was added by the Orchestrator after an audit finding, to prevent
regression against a ruling it had just made. The right regression guard for a behavioural defect is
a behavioural test. These were compliance machinery for the campaign's own rulings, dressed as tests.

**What remains and why it is enough.** The behavioural guards stand: the 25-input legacy
behaviour-freeze suite, the 41-row collapse suite, the driven per-door transport proofs, the
exchange-ownership probes in `tests/setup.ts`, and the real-client conformance run at 23/0. Those
test what the package does. `tests/policy.test.ts` keeps five genuinely general fleet-canon tests.

**Post-deletion gates, all green:** `check` 0, `format:check` 0 across 189 files, `lint:check` 0,
`test:src` **1,000**, `test:policy` **5**, `test:guides` **121**. Custody unchanged.

## The conformance fixture is invisible to the typechecker (measured 2026-08-09)

`scripts/conformance.mjs` is plain JavaScript consuming `dist/`, so it implements typed interfaces
with **no compiler checking it**. `scripts/` is in no `tsconfig` include.

Renaming two public port accessors — `MCPResourceManagerInterface.read` → `resource` and
`MCPPromptManagerInterface.get` → `prompt` — left the fixture implementing members that no longer
exist. Conformance fell **23/0 → 16/7**, and **five of six gates stayed green**: `format:check`,
`lint:check`, `check`, `build`, and all **1,158** tests. Only the real-client run caught it.

Two standing consequences:

- **A public API rename reaches `scripts/` and must name it as an owned file.** Marking `scripts/**`
  off-limits in a rename brief guarantees this break; it was marked off-limits in both fix rounds.
- **Run `node scripts/conformance.mjs` after any change to a published port**, not only at
  acceptance. The suite cannot substitute for it, because the suite never loads the fixture.

W08 owns the deeper question: whether the fixture should carry checked types so a rename fails at
`check` instead of at the real-client run.

## Host environment facts (measured 2026-08-08, state them in every writing brief)

Two frictions cost a round trip each, repeatedly, until they were written down. Both are properties
of this machine, not of any unit.

- **`npm` must be invoked as `npm.cmd`.** The PowerShell `npm.ps1` launcher is blocked by the machine
  execution policy and dies **before** any repository command runs. Three separate Sol execs hit this
  and each correctly refused to count it as a test result — but each lost a round trip discovering it.
  A blocked launcher is harness evidence, never a red count.
- **A Codex exec has no network** (`--unshare-net`). `npx --yes` fails `EACCES`, so
  `scripts/conformance.mjs` and anything else touching the registry **can never run inside a
  dispatched unit**. That work belongs to the Orchestrator's own tracked commands or a
  network-capable native agent. Authorizing it in a brief is a dispatch error; it was made twice.
  The conformance runner is cached at
  `~/.npm/_npx/bac77c2e1c06ed68/node_modules/@modelcontextprotocol/conformance` and its scenario
  source is **readable offline** — which is how the RFC 6570 question was settled without a run.

## Custody re-baseline (2026-08-08, user-confirmed)

The user bumped dependencies mid-campaign: `@orkestrel/contract` `0.0.9`→`0.0.10`, `@orkestrel/guide`
`0.0.8`→`0.0.9`, plus `@types/node` and `vite`. A real install rewrote the lockfile. This was
**intentional and user-owned**; the earlier freeze values are superseded.

**Current freeze:** `package.json` sha256
`cbcdccbe5e09f6eeec9208e070241a65fe9f4d77d7081cb366438b7c2710b15f`; `package-lock.json` sha256
`421f90324de293048900d0395b8bc4d5b9a7e32fe01f4e26f6f40d4210963b36`, **79,057 bytes**;
`git status --short` = **81**.

**Proven green on the new set** by an independent verifier: five gates exit 0, `npm test` **1,060
passed**, zero divergence from the pre-bump baseline.

**The standing procedure, corrected by this episode:** a dependency file moving is a **stop-and-ask**,
never a stop-forever and never a restore. The orchestrator halts writers, reports the exact hashes and
what the installed tree now contains, and — once the user confirms ownership — **re-baselines and
re-runs all five gates to prove the tree is still green** before continuing. Halting permanently on a
change the user made is as wrong as absorbing one they did not.

## What this package does and does not do (plain statement, revised 2026-08-09)

Written without jargon, because every other statement of scope in this file is written for an
engine and this one is for a human deciding whether to ship.

**MCP servers offer three main capabilities: Tools, Resources, and Prompts. This package now
implements all three**, plus Tasks, subscriptions, progress, elicitation, cancellation, and both
protocol eras.

**The conformance run is `23 passed / 0 failed`.** Nothing is declared, deferred, or excused.

**The superseded statement, kept because it is the honest record.** Until W09 this file said the
package implemented Tools and _"neither Resources nor Prompts"_, that the shortfall was `13/10`, and
that a developer wanting to expose a file or a prompt template _"cannot do it, and will discover that
after choosing us."_ It offered two options: ship tools-only and say so prominently, or build the two
capabilities. **The user chose to build them**, and every one of those sentences is now false.

**How they are built matters more than that they are.** Resources and Prompts ship as
**consumer-supplied ports** — `MCPResourceManagerInterface`, `MCPPromptManagerInterface`, and an
independent completion port — following the `ToolManagerInterface` precedent this package already
used. The host owns the registry; MCP projects it to the wire and owns no storage. That is why the
capability arrived with **no new dependency**: `@orkestrel/workspace` and `@orkestrel/template` are
wired _behind_ the ports by a consumer, never imported here. The guide ships worked adapter material
naming the real seams, including the ones that tear — workspace addresses by path rather than URI and
has a closed four-value binary MIME set, and `Template.fill()` returns a string where `prompts/get`
must return a message list.

**The remaining honest non-goals**, unchanged and still correct: Roots, Sampling, and Logging — all
deprecated at `2026-07-28`, with no registry and no consumer — and a **built-in resource or prompt
store**, because a default store is product policy and these capabilities ship as mechanism.

**W08 cites `23/0`.** There is no longer a shortfall to explain, only a number to state.

## Standing design ruling — MCP expands no URI templates (W09-A, 2026-08-09)

The open question the plan carried was _"which RFC 6570 level should `resources/templates/list`
support?"_ — the level is unstated in both the dated schema and the spec prose. The Orchestrator
directed Level 1. **The writer answered better, by dissolving the question instead of picking a
level.**

`MCPResourceManagerInterface.read` takes a **concrete URI**. The manager owns template matching and
expansion; the server only projects `uriTemplate` strings as descriptors. **MCP therefore needs no
template engine and implements no RFC 6570 level at all.**

The conformance runner confirms this is the intended shape rather than a convenient dodge: scenario
`resources-templates-read` sends the **already-substituted** `test://template/123/data` and asserts
only that the returned content reflects it. Substitution was always meant to happen behind the port.

**Binding consequence for `completion/complete`:** a `ResourceTemplateReference`'s `uri` may be a
template, and completing its arguments implies knowing that template's variables. That routes to the
host too — the party that owns expansion owns knowing its own variables. Parsing templates inside
MCP would reintroduce the engine this ruling removes.

## Standing design ruling — legacy is a collapse, not a retain (W07, 2026-08-08)

Two blind design lanes ran the same brief and **disagreed on the pivotal fact**. The objective lane
ruled `retain`, citing `#runTool`'s own comment: _"Shared by both eras — only the result STAMPING
differs."_ The subjective lane checked the call sites instead. **The orchestrator verified it
first-hand and the comment is false:**

- `#runTool` has **exactly one call site** — `MCPServer.ts:307`, inside `#legacy`. The modern path
  never touches it.
- `MCPServer.ts:1231` calls `this.#options.tools.execute(call)` **directly**, while the modern path at
  `:611-613` routes through `this.#options.execution` when configured.

**So a legacy `tools/call` bypasses the consumer's execution port, `#input`, `#defer`, `#progress`,
and the request signal.** Legacy calls are uncancellable and invisible to a deployment's task policy,
and the Terminal architecture's load-bearing clause — _"over the same modern execution/Task
backend"_ — is **false in code**, not merely unproven.

**Ruling:** legacy becomes a **decorator over the one dispatcher**. It translates onto the modern
engine and owns no engine. Three outcomes that do not currently fail closed — Tasks diverge silently,
`input_required` is unreachable, MRTR params pass unread — then close as a **consequence** of the
collapse rather than as three new guards.

**Also corrected on the record: no shipped sentence claimed removability, and W07-B made one true.**
The unbacked claim was the plan of record's, not the product's — an orchestrator error, stated here
because it changed how the unit was framed. `guides/src/mcp.md` now names the cost exactly — **seven
published modules**, two whole files and five declared rows — and that sentence is a membership rule
with an executable referent rather than a reassurance. `tests/policy.test.ts` computes the
legacy-owning set from the tree and requires it to **equal** `LEGACY_SURFACE_MODULES` in both
directions, so neither an undeclared participant nor a stale declaration can survive.

**The plan's own containment rule was the instrument's first defect, caught by measuring it.**
W07-B's brief specified membership as _"reachable in the import closure of a legacy root AND names a
legacy token"_. Executed, that rule computes **nine** modules — over the stop threshold — while
**missing** `core/factories.ts`, `core/index.ts`, `server/index.ts`, and `server/middlewares.ts`,
because no legacy root imports a barrel and the closure runs the wrong direction. Those four are
exactly the rows the removability sentence tells a reader to delete. Under substring tokens it also
declares `core/types.ts`, `core/helpers.ts`, and `core/validators.ts` deletable, which is false.
Membership is therefore **naming one of the two legacy entities whole** — `MCPLegacy` or `MCPSession`,
identifier or module specifier — which computes exactly **seven**. The fragment machinery is retained
and load-bearing in Law 1, so no clause reads as covered while matching nothing. **This is Ruling 2
applied to a rule the Orchestrator wrote, not one an executor invented**, and the writer asked for
confirmation rather than accepting its own substitution. Confirmed.

**The collapse initially widened only the HTTP face, and writing the truth down is what found it.**
W07-B discovered — while verifying a sentence it had just authored — that `createWebSocketServer`,
`createStdioServer`, and `bindServer` still took `MCPServerInterface` and could not be handed the
decorator, so a stdio or WebSocket deployment served the modern revision only. Before the collapse
those doors served both eras, making it a **capability regression that passed every gate**: the
freeze suite drives `dispatch` directly and the transport fixtures had been updated to modern-only.
Ruled a defect rather than a documented limit — stdio with an `initialize` handshake is the most
common shape an MCP server ships in — and repaired in W07-C.

**Port ruling (W07-C, 2026-08-09): `MCPDispatcherInterface` carries `emitter`.** Widening the three
doors did not typecheck, because `bindServer` reports contained faults through
`server.emitter.emit('error', …)` and the port carried no emitter. The HTTP face never surfaced this
because it answers through a response; a binder owns a pump and has only an event. **`MCPLegacy`
forwards the dispatcher it wraps rather than minting its own** — legacy owns no engine, so its
contained faults are the deployment's faults, and a second emitter would give one server two error
feeds where an operator subscribed to `mcp.emitter` would silently miss every fault arriving through
the legacy door. One server, one feed.

**Named risk, carried into the unit:** no legacy foreign client exists anywhere in the harness, so
this unit's evidence structurally cannot see everything the collapse changes. Behaviour-freeze
fixtures are captured **before** any edit, and any divergence not enumerated as a matrix row is a
defect.

**Sequencing:** W09 (Resources and Prompts) runs **first**. It is user-directed, additive, and safe —
`#legacy`'s switch has a `default` returning method-not-found, so new modern methods are automatically
refused over legacy with no per-method era decision. The largest refactor in the campaign does not sit
in front of requested feature work.

## Progress ledger

Statuses mean acceptance of the named unit, not that precursor code happens to exist.

| Order | Unit                                                             | Status               | Exact boundary and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----: | ---------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     0 | Protocol research and canonical architecture (`00`-`07`)         | **complete**         | Dated research, authority hierarchy, requirements, and W01-W08 architecture were reconciled. This accepts design, not code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|     1 | `@orkestrel/guide@0.0.9` release/integration (`78`, `80`, `87c`) | **complete**         | Published, declared, lock-resolved, installed without override/link, and mirrored byte-identically. This does not accept MCP's Guide consumer harness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|     2 | Guide-in-MCP public surface and I94 (`85`-`96`)                  | **complete**         | Accepted 2026-08-08 after 11 falsification rounds and 9 fix rounds. Terminal evidence: both blind Opus lanes `PASS — 4 of 4, no findings outside the claims` (round 141); verifier gates guides **81/81**, `src:core` **334/334**, `src:server` **196/196**, `check`/`lint:check`/`git diff --check` exit 0. Red/green: U1 5 failed→12 passed; U2 6 failed→68→73; fix2 →18/79; final →19/81. Every finding bound by a mutation that fired and reverted byte-exact. `src/core/MCPProgressReporter.ts` byte-stable at `6bfe8235…` since round 126 — the code was correct from there and every later round was documentation and instruments catching up. Known-pre-existing and NOT owned by this row: `test:policy`'s two violations at `src/server/factories.ts:39-40` (row 4) and four format-drifted files (W08).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|     3 | V wire/ownership substrate (`20d`, `27f`, `29c`, I30)            | **complete**         | Accepted 2026-08-08 after 7 falsification rounds and 7 fix rounds. Terminal evidence: both blind Opus lanes `PASS — 5 of 5, no findings outside the claims` (round 167); verifier `GATES: GREEN` — guides **81/81**, `src:core` **339/339**, `src:server` **196/196**, `test:policy` **4/4** (was 1 failed), `check`/`lint:check`/`diff --check` exit 0. **`30a`'s blocker was stale**: Guide 0.0.8 forced three exports onto the public Surface, and the architecture decision later made all four intentional public declarations. **Live-state reproval closed 2 of 4 historical findings without reimplementation** (reporter ordering; `snapshotToolResult` preflight). Two live defects fixed: the parser TSDoc named half its guard pair (composite with `isBoundedJSON`, same `serializeJSON` engine), and the two hidden function assignments in `createMCPContinuation`. Substrate absorbed 240,000 value/limit pairs, 73,114 out-of-population key samples, 36 hostile probes, 300,000 modern-request candidates — **zero soundness violations**; `src/` unchanged since the fix unit. Deferred item: delete the threshold-decomposition sentence in `tests/src/core/parsers.test.ts` the next time that block is opened (both lanes pre-verified the deletion is anaphorically safe).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|     4 | Remaining V successor repair and acceptance                      | **complete**         | Accepted 2026-08-08 under the revised bar. Coverage was: reprove four items + fix **D1**. Reproval found reporter concurrency, `snapshotToolResult` preflight and parser TSDoc **already CLOSED**, and the `src/server/factories.ts` claim **not substantiated** (method shorthand is a permitted member declaration; the policy gate's `isArrowFunction`/`isFunctionExpression` scoping is deliberate — verified by executing `inspectCodingLaw` on seven synthetic shapes plus a whole-tree AST scan). D1 fixed, and four defects the fix rounds themselves created were found and fixed: the install-before-send window reopened one statement later, a double close, a zombie attempt closing a live connection, and a timed-out close being treated as a failed one (which bricked the client permanently). Terminal evidence: verifier `GATES: GREEN` — `format:check` exit 1 naming exactly the three known W08 files; `lint:check` 0; `check` 0; `build` 0 (with the known API Extractor TypeScript 6.0.3 warning, W08's); `npm test` **691 passed** (src 606, policy 4, guides 81). Red/green: `57 → 5 failed/59 → 64 passed`; `1 failed/64 → 65`; `3 failed/85 → 88`; `2 failed/89 → 92`. `src:core` **339 → 374**. Mutation matrix 47 in-population + 1 outside control, 41 bound in isolation. Custody 34 throughout, `package-lock.json` intact at `6f915c9b…`/75,446 bytes, HEAD `8d77e14f…`. `src/core/MCPClient.ts` `54aad8c0…`. **Process finding:** four audit rounds ran after coverage was complete; under the revised bar those would have been deferred defects and this row would have closed eight rounds earlier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|     5 | S00/L01 invocation and stream carrier boundary (`22c`) + W01     | **complete**         | Accepted 2026-08-08 under the revised bar, the first unit run with a persisted capability matrix ([`196`](tmp/mcp-hardening-20260807/196-row5-w01-matrix.md), 46 rows: 19 implement, 18 repair, 8 retain, 1 exclude). Split on the crosswalk's own line: **Unit A** rows 1-31 (carrier boundary), **Unit B** rows 32-46 (naming audit, guide parity). Shipped: `JSONRPCId`; `JSONRPCRequest` requires `id`; `JSONRPCNotification` forbids it via `id?: never`; `JSONRPCInvocation`; mutually exclusive `JSONRPCResultResponse`/`JSONRPCErrorResponse` enforced by `?: never` members; `MCPResult` with required `resultType` plus the `MCPLegacyResult` arm W07 removes; `MCPStream` yields notifications; `MCPMethodOptions` with a required `signal`; three `dispatch` overloads; **`id: null` eliminated from every modern path** (21 sites → 0, 94 builder call sites typed). W01 renamed the `Elicit*` family, the `Input*` family, `ClientTransportInterface`→`MCPClientTransportInterface` (113 occurrences, 21 files), deleted two speculative exports, and recorded four retain rationales. Red→green: Unit A `6 failed → 418 passed`, server `7 failed → 196`; Unit B guides `3 failed/78 → 81/81`. Terminal: `src:core` **339 → 424**, `src:server` **196**, `src:browser` 36, `test:policy` 4, `test:guides` **81/81**, `check` 0, `lint:check` 0, `format:check` **exit 0 — zero drift tree-wide** (the three long-standing W08 drift files were formatted incidentally by the renames; that W08 scope is retired). Protocol authority **reverified against primary source** the same day and recorded above; it corrected the matrix before implementation, flipping the `subscriptions/listen` filter keys from "regroup" to **retain — spec-fixed wire spellings**, a change that would otherwise have broken conformance silently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|     6 | S01-S05/L02-L06 acceptance carriers                              | **W01-W06 accepted** | **W05/W06 accepted 2026-08-08** — 40-row matrix ([`219`](tmp/mcp-hardening-20260807/219-w05-matrix.md)), rows 17-18 and 30-33 excluded with evidence. Shipped across three writers: `sendStream` narrowed and releasing on every exit; `sendEventStream` extracted; `HTTPDisconnect` split; `bindServer` decoding under `server.limit` with a per-live-request registry honouring inbound `notifications/cancelled`; `MCPServerInterface.limit`; D2/D3 repaired; task containment recomputed as **reachability from dispatch** with `TASK_CLIENT_MODULES` deleted; `duplex` driven; a browser containment sweep; one shared version projector; and the conformance runner **actually executed** after W06 fixed a `spawn npx ENOENT` that had made it unrunnable on this platform. Audit round 1: both lanes `FAIL` (objective 7 broken, subjective 2 broken + 1 outside-claims), and **the escalation budget fired a second time at exchange ownership** — the fourth defect arrived by a mechanism the standing ruling did not model, producing **[the revocation ruling](#standing-design-ruling--revocation-is-the-fifth-exit-w05w06-escalation-2026-08-08)** and, independently, **[the instrument-contract ruling](#standing-design-ruling--an-instruments-stated-rule-is-its-contract-w05w06-2026-08-08)**. Fix round A (Sol) implemented the revocation ruling and closed four defects, each red→green on an identical command: A1 `1 failed/650 → 651` asserting **both** orders; A2 stdio `1/222 → 223` and WebSocket `1/224 → 225` (the two **client** doors — a brief error claiming four doors was caught by the writer and verified, since both server transports hold constructor-fixed peers with idempotent `start()` and are a documented retain); A3 `1/225 → 226`; A4 `1/230 → 231` clamped to `2_147_483_647` after `2_147_483_648` produced Node's overflow warning and five busy-loop comments. A5 records the foreign-controller disposal obligation as a **contract statement, not a repair**, per the reachability rule. Fix round B (Opus) closed the evidence layer: the containment instrument now matches its own stated rule (7 smuggles invisible → C/D/E/G caught, A/B/F recorded as genuinely unreachable), the template-literal dispatch root closed rather than documented, and **the conformance baseline re-derived from the product rather than the fixture — 8/15 → 13/10**, with all ten remaining failures declared non-goals and no gap category dangling. Terminal: **`GATES: GREEN`** (independent verifier) — `npm test` **1,060 passed** (src 930 = core 651 + server 231 + browser 48, policy 29, guides 101), `format:check` 0 across 183 files, `lint:check` 0, `check` 0, `build` 0 with the known API Extractor warning, `package.json` and `package-lock.json` byte-exact at 75,446 bytes, status 80, no residue worktrees.                                                                                                                                                                                                                                                                    | **W04 accepted 2026-08-08** — 42-row matrix ([`213`](tmp/mcp-hardening-20260807/213-w04-matrix.md)) split request-seam/task-client, with rows 14-16 gated on a primary-source pass that **confirmed** the `notifications/cancelled` spelling field-for-field and, reading for a different question, found a **live conformance gap**: a server MUST send that notification on `subscriptions/listen` teardown and ours does not (handed to W05). Two deferred rulings came due and both landed: **`discover()` now rejects** a `resultType`-less modern result and **fails closed** (it had been _inventing_ `resultType: 'complete'`), and **`MCPMethodHandler` narrowed** to `JSONRPCRequest` — W02 had kept it wider for a future that proved _structurally unavailable_, since the `AbortController` a cancellation handler would need is a function-local `const` reachable from no registry; an audit lane confirmed by reflective sweep from inside a live handler that **zero** controllers are reachable. Also shipped: `MCPCallOutcome` with a `matchesResultType` whitelist, `structuredContent` preferred by presence, per-request cancellation, `MCPTaskClient` at `client.tasks` holding no timer/scheduler/cache (proven by a frame recorder over real elapsed time whose control was a consumer scheduler that _does_ poll). **The seven-member fence on `MCPClient.ts` held byte-identical** through both units, verified independently by two lanes with extractors each proved able to fail. Audit round 1: both lanes `FAIL`; five repairs. Red→green: A `561 → 608`, B guides `1 failed/95 → 101` and core `608 → 623`, fix round `→ 625`; the narrowing `41 tsc errors → 0`; the abort-listener instrument `625 passed without it → 4 failed with it`. Terminal: **`GATES: GREEN`** — `npm test` **969 passed** (src 857, policy 11, guides 101), `format:check` 0 across 183 files, `lint:check` 0, `check` 0, `build` 0, lockfile and `MCPClient.ts` byte-exact, no residue. | **W03 (Tasks) accepted 2026-08-08** — 48-row matrix ([`207`](tmp/mcp-hardening-20260807/207-w03-matrix.md)) split materialization/lifecycle, of which **rows 35-40 and 43 were excluded with evidence**: the `subscriptions/listen` task-notification envelope is **refuted**, not merely unconfirmed (ext-tasks declares `TaskSubscriptionNotifications` and never references it; the composing type lives outside the extension), so B closed at 17 rows and A did not move — which is why the split put every gated row in B. Shipped: `MCPTaskManagerInterface` (`start`/`task`/`update`/`abort`, **no plural accessor** — the missing member is how the port states MCP supplies no `tasks/list`); `MCPTaskContext` carrying **no signal**, proven by a fixture pair where binding the request signal yields `cancelled` and an owned lifetime yields `completed`; the server-decided `#defer` seam with capability-gate → policy → `start`; three `tasks/*` handlers registered only when configured; `MCPTaskDetail` status→payload narrowing. **Two protocol corrections landed before implementation**: `GetTaskResult.resultType` is `"complete"`, not `"task"` (only `CreateTaskResult` carries `"task"` — symmetry reasoning would have been wrong on three methods), and **the `-32003` ruling was reversed to `-32021`** after the W03-A writer surfaced that the dated core schema and Final SEP-2663 both fix `MISSING_REQUIRED_CLIENT_CAPABILITY = -32021` while ext-tasks' draft prose carries stale `-32003` examples — an Orchestrator error caught at the last cheap moment. Audit round 1: both lanes `FAIL`; seven repairs, of which the sharpest was an **authorization bypass** (`#update`/`#abort` probed with `found === undefined` while `#task` re-proved with `isMCPTaskDetail`, so a manager answering `null` got both invoked for a nonexistent task and the client told success). Red→green: A `503 → 527`, B parity `1 failed/90 → 96` and core `527 → 557`, fix round `→ 561`. Terminal: **`GATES: GREEN`** — `npm test` **899 passed** (src 793, policy 10, guides 96), `format:check` 0 across 181 files, `lint:check` 0, `check` 0, `build` 0 with the known API Extractor warning, lockfile byte-exact, no residue worktrees. | Carriers are embedded in their owning W01-W06 units, not a separate pass. **W01 accepted** with row 5. **W02 accepted 2026-08-08** — 58-row matrix ([`199`](tmp/mcp-hardening-20260807/199-w02-matrix.md)) split egress/ingress across two serial writers, then one fix round from a two-lane audit and one scoped verification round. Shipped: `JSONRPC_INTERNAL_ERROR = -32603` replacing modern `-32000` at all seven sites (legacy retained); `#contain` as the single containment seam with the broadened `error` event; subscription notifications owned before matching and stamping; `MCPStreamController`/`MCPTextStreamController` with one wrapping seam in `#dispatch`; the uniform `#register` seam (`server/discover` and `tools/list` had been dropping resolved options); `isElicitContent` enforcing the issued schema; `MCPInputState.schema`; original-id binding across rounds; expiry rechecked around every provider await; `EMPTY_MCP_ARGUMENTS`; `isRFC3339Date`/`isRFC3339DateTime` (invalid calendar dates such as `2026-02-30` had been accepted); `serializeStream` deleted as a pass-through factory. Red→green: W02-A `42 failed → 467`; W02-B `13 failed → 494`; fix round `503`. Terminal: **`GATES: GREEN`** — `npm test` **830 passed** (src 735, policy 4, guides 91), `format:check` 0 across 351 files, `lint:check` 0, `check` 0, `build` 0 with the known API Extractor TypeScript warning (W08's), lockfile byte-exact at 75,446 bytes. Audit: round 1 both lanes `FAIL` (six repairs); round 2 `FAIL — 1 broken`, and that break is **row 46's, already excluded to W05** — the matrix predicted the defect at the place it named. |
|    7b | Resources and Prompts W09 (user-directed)                        | **complete**         | **Accepted 2026-08-09.** User-directed scope added mid-campaign and sequenced **before** W07, because these are modern capabilities and the legacy translator translates whatever the modern backend does. 26-row matrix ([`228`](tmp/mcp-hardening-20260807/228-w09-resources-prompts-matrix.md)), three serial writers. **A (Sol)** — `MCPResourceManagerInterface` (`resources`/`read`/`templates`), resource/template/contents types with structural `text` xor `blob`, and **one shared pagination shape**; red→green `7 failed/3 passed → 12/12`, core `651 → 663`. **B (Sol)** — `MCPPromptManagerInterface` reusing that pagination with **no second cursor shape**, `prompts/list`/`get`, and `completion/complete` through an **independent host completion port** forwarding `ref/resource` **verbatim**; core `663 → 672`, no deviations. **C (Opus)** — parity `101 → 116`, the two false statements repaired, the fixture wired. Controls came from outside each population throughout: an **in-memory `Map` manager** proving the port is not a workspace-shaped hole; a **105-candidate** completion source proving the 100-value cap is applied rather than documented; oversized page capacity proving `nextCursor` is computed rather than always emitted; independent capability gates proving `-32601` per capability rather than one global switch. Parity was proven live by two probes from **different** populations (a Surface row and a new method-table row). **The headline: `node scripts/conformance.mjs` moved `13 passed / 10 failed` → `23 passed / 0 failed`, the two runs serving as each other's control on the same build — so the number discriminates product from fixture — with NO `src/` edit required to close any scenario.** Every declared conformance gap is gone. C also refused to ship a `@orkestrel/workspace` code fence because that package is not installed here, writing prose seams instead of unverifiable member names in a durable guide. Terminal: **`GATES: GREEN`** (independent verifier, second pass) — `npm test` **1,096 passed** (src 951, policy 29, guides 116), conformance **23/0** with `dns-rebinding-protection` 2/0, `format:check` 0 across 185 files, `lint:check` 0, `check` 0, `build` 0 with the known API Extractor warning, status **83**, both dependency files byte-exact at 79,057 bytes. The **first** verifier pass caught `src/core/validators.ts` failing `format:check` after two writers had each reported their own checks clean — which is precisely why a writer's self-report never establishes green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|     7 | Modern W01-W06                                                   | **complete**         | All six modern units are implemented and accepted: types/names (W01); modern server/execution/progress/MRTR (W02); Tasks/provider/subscriptions (W03); client/task/cancellation (W04); Node HTTP lifecycle (W05); browser parity and the real-host proof (W06). Evidence is embedded per unit in row 6. The modern backend is now the accepted substrate W07's legacy translator sits on top of, which is the ordering row 8 required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|     8 | Removable legacy W07                                             | **complete**         | **Accepted 2026-08-09.** Three serial writers under the collapse ruling. **A (Sol)** — captured **25 behaviour-freeze inputs BEFORE any edit** (the unit's only instrument, since no legacy foreign client exists anywhere in the harness); **22 identical, 3 declared divergences**, and the detector immediately caught an accidental one nobody predicted: the decorator's temporary modern stamp made the payload bounded **twice**, so a tight legacy budget rejected ordinary results — silent, size-dependent, invisible to every existing test. Shipped `MCPDispatcherInterface` + `MCPLegacy` as a decorator owning no engine; `MCPServer` ends with **zero** matches for `#legacy\|normalizeLegacy\|isModernRequest\|MCPLegacy\|MCPEra` and no import of the legacy layer (verified independently, twice). One result pipeline; `#normalizeLegacy` and `normalizeLegacyJSON` deleted. The false `#runTool` comment that misled the first design lane was deleted with it. Three outcomes that only failed closed **by accident** now close **by consequence**: a task returns `-32000` with **zero task starts** (the capability gate finally runs), `input_required` returns `-32000`, MRTR continuation params return `-32602` instead of passing unread. `id: null` **excluded with evidence** to W08 — the dated 2025-06-18 schema was unreachable offline and a guess was refused. **B (Opus)** — parity `116 → 121`, policy `29 → 38`, the three legacy-visible behaviour changes documented with their shared cause (legacy inherits modern validation because it now runs on it), and the boundary instrument: Law 1 subordination, Law 2 containment with the computed set required to **equal** the declared set in **both** directions, a control from inside the population that must report, and a control from **outside** it asserted as the recorded blind spot at its true width. It also caught a defect in the Orchestrator's own brief — the prescribed containment rule computed **nine** modules while missing the four barrel/factory rows the removability sentence names — and fixed the rule rather than the sentence, asking for confirmation instead of accepting its own substitution. **C (Sol)** — repaired the capability regression B found: all five factories now take the port, each door proven end to end against a **real** transport (real socket pair, spawned child, cross-wired duplex), with both control vectors per door. Its stop was correct and produced the `emitter` port ruling. Terminal: **`GATES: GREEN`** (independent verifier) — `npm test` **1,157 passed** (core 714, server 236, browser 48, policy 38, guides 121), conformance **23/0** with `dns-rebinding-protection` 2/0, `format:check` 0 across 187 files, `lint:check` 0, `check` 0, `build` 0 with the known API Extractor warning, status **86**, both dependency files byte-exact at 79,057 bytes. **Two Orchestrator specification errors were caught by writers before shipping** — a widening that could not typecheck, and the wrong error code for a control — and both were answered better than specified. |
|     9 | Consumer and final W08                                           | **complete**         | **Accepted 2026-08-09.** 17-row matrix ([`249`](tmp/mcp-hardening-20260807/249-w08-matrix.md)), three writers. **A (Sol)** built the generated consumer at `tests/src/server/consumer.test.ts` — a scratch consumer whose `node_modules/@orkestrel/mcp` points at the repo root, so Node resolves the **real `exports` map** exactly as an installed consumer does. ESM passes on all three faces (core dispatched `tools/list`, server mounted `POST /mcp`, browser moved a real `MessageChannel` frame); CJS passes on `.` and `./server`; `require('@orkestrel/mcp/browser')` correctly fails `ERR_PACKAGE_PATH_NOT_EXPORTED`. All three outside controls fired: an undeclared subpath rejected, browser CJS rejected, and a deliberate type error rejected with `TS2322` — that last one proving the type instrument **can** fail. **It immediately found a publication blocker no gate here could see:** the shipped `dist/src/{browser,server}/index.d.ts` imported core through `'../core/index.ts'` and `'../../core/index.ts'`, neither of which exists, using a `.ts` source extension inside a declaration. Seven `TS2307` errors for any consumer. Every gate typechecks `src/`, never the emitted declarations, and nothing had ever consumed them from outside. **C (Sol)** repaired it by making core **external** to the face bundles so declarations reach it through the published `@orkestrel/mcp` specifier — a consumer's core and browser types are now the same types, not structural twins. When its first attempt hit a real API Extractor limit, it kept the design and narrowed the rewrite to the final face rollup. Verified independently: **0** `.ts` specifiers in either file, 14 and 17 `@orkestrel/mcp` imports. **A also closed the untyped-fixture hole:** `scripts/conformance.mjs` now carries `// @ts-check` with JSDoc contracts under `check:src:server`, surfacing 18 untyped errors before going green — so the rename class that silently took conformance 23/0 → 16/7 now fails at `check`. **B (Opus)** wrote the closing record: five broken guide table rows repaired (not the one reported — it built two instruments with controls, both reporting 5 → 0), `CHANGELOG.md` created with its non-shipping note first, and four limits recorded **with their numbers** — the API Extractor warning read from the installed source and explained as `logInfo` (which is why `build` exits 0), source maps at **1,130,238 bytes of 2.5 MB**, the absent top-level `types` field affecting only `moduleResolution: node` consumers, and **no IDE claim at all**. `id: null` was **excluded with evidence**: the dated 2025-06-18 schema is absent from repository, installed modules, and npm cache with no network, so a legacy client receives an uncorrelated error and no code was changed on a guess. Dual-era `MCPClient` removability recorded as an open design question, not a defect.                                                                                                                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|    10 | Whole-package publication readiness                              | **complete**         | **Accepted 2026-08-09** on independent verifier evidence, all seven gates in order. `format:check` **0** across 185 files; `lint:check` **0**; `check` **0**; `build` **0** with the known API Extractor warning three times, quoted and recorded; `npm test` **1,128 passed** (src 1,002 across 28 files, policy 5, guides 121); `node scripts/conformance.mjs` **23 passed / 0 failed** with `dns-rebinding-protection` 2/0. **Package-content acceptance:** `npm pack --dry-run` — **18 files, 624.3 kB packed, 2.5 MB unpacked**, containing only `LICENSE`, `README.md`, `package.json`, and 15 `dist/src` artifacts. No test, no `tmp/`, no campaign artifact, no `.orkestrel/` ships; `CHANGELOG.md` is deliberately repository-only because `files` is `["dist/src", "README.md"]`. No tarball was written. Custody exact throughout: `package.json` `cbcdccbe…`, `package-lock.json` `421f9032…` at 79,057 bytes. Structural proof that the declaration blocker stayed fixed: **0** `.ts` specifiers in both shipped face declarations. **No publish is authorized and none was performed.** Publication remains the user's action; the deliverable is a package prepared for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Deferred defects promoted from audit rounds

These were found by row-2 falsification rounds, reproduced, and deliberately **not** fixed there
because their files lie outside that row's subject. They are binding findings for their owning rows,
not suggestions. Each is reproducible with plain API and no hostile substrate.

| ID  | File                                                           | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Owner           |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| D1  | `src/core/MCPClient.ts:163`, `:510`                            | `connect()` checks `if (this.#connected) return`, then suspends across `transport.start()` and one or two full discovery round trips, then installs `#connected = true` at `:207` without re-asking. `#initialize()` repeats it at `:510`. Two concurrent `connect()` calls both run full handshakes; a `disconnect()` awaited during a suspended `connect()` returns as a no-op at `:264` and the in-flight connect then marks connected over a transport that was never closed.                                                                                                                                                                                                                                                                                                                                               | rows 4 / 7      |
| D2  | `src/server/transports/WebSocketClientTransport.ts:80`, `:112` | `start()`'s sole guard is `if (this.#socket !== undefined) return`, then it suspends across a real TCP connect and HTTP upgrade and installs `#socket` at `:112` without re-asking. Two concurrent `start()` calls both complete handshakes and the second overwrites the first, orphaning a bound, never-closed socket that still re-emits frames. `close()` awaited during a suspended `start()` is an effective no-op, leaving a permanently leaked live connection on a transport whose observable state says closed.                                                                                                                                                                                                                                                                                                       | row 7 (W05/W06) |
| D3  | `src/server/middlewares.ts:179`, `:206`, `:209`                | `createMCPSession` stamps `touched: clock()` when minting the entry, suspends at `await next(forwarded)` across the consumer's route handler and tool execution, then installs the entry carrying the **pre-suspension** timestamp. `src/server/types.ts:262-263` defines `touched` as "the epoch-ms instant of the **last access**", so the idle window is measured from request start. A session whose `initialize` round trip takes ≥ `ttl` is inserted already expired and 404s on the next request for the id just advertised in `Mcp-Session-Id`; a continuously-used session whose requests each exceed `ttl` is evicted mid-use. Same stamp-before-await applies to the resolved-existing entry at `:140-141`. Fix: re-read the clock after the await and install `{ ...entry, touched: clock() }` on the success path. | row 7 (W05)     |

Enumerated and found **sound**, so this is a bounded finding rather than a blanket suspicion:
`StdioClientTransport.start()` (synchronous `spawn`), `StdioServerTransport.start()`,
`WebSocketServerTransport.start()` (both set state before any suspension),
`HTTPClientTransport.start()` (installs no state), `HTTPDisconnect.bridge()` (synchronous, idempotent
`#stop()`), `MCPSession`, `MCPMethodManager`, the three browser transports
(`src/browser/transports/WebSocketClientTransport.ts:83-87` installs `#socket` **before** its await;
`HTTPClientTransport` installs no state; `MessagePortTransport` is synchronous), the middleware
`DELETE` and `GET` paths (`src/server/middlewares.ts:129-133`, `:145-167` — install nothing across a
suspension), and `MCPServer`.

**Correction to an earlier version of this list:** `MCPServer` was recorded here as having "four
`readonly` fields and no mutable state, so it structurally cannot carry the shape". That reason is
**false** — `src/core/MCPServer.ts:108` declares a mutable `#subscriptions = 0`. The conclusion still
holds, but for the real reason: the limit check at `:678` and the increment at `:685` are adjacent and
synchronous, with no suspension between them. A wrong reason would license skipping the file on a
re-sweep, so the reason is recorded rather than the verdict alone.

**The class, stated once so the owning rows fix the rule rather than the instance:** a method whose
entry guard establishes a fact, which then suspends across caller-reachable work, must **re-ask every
fact that guard established** before installing state. This defect has now been found five times in
this campaign — `report()`, `take()` (twice), `MCPClient.connect()`, `WebSocketClientTransport.start()`.
Sweep it across the package once instead of patching each door as it is discovered.

Verifier 105 later ran an out-of-scope exploratory full sweep. It reconfirmed the four known format
drifts and the two hidden function assignments carried by remaining V; source tests reached 554/554,
but the policy failure stopped the chained Guide suite. Lint, check, and build exited zero. Build
also warned that bundled TypeScript 5.9.3 is older than the target TypeScript 6.0.3; W08 owns
declaration-toolchain compatibility and must resolve or explicitly account for that warning before
publication. These results are evidence of the pending rows, not acceptance.

## Guide-parity harness: durable conclusions

Promoted out of test comments so they survive the `tmp/` sweep. These describe what the harness
guarantees today; they are not campaign history.

**The trivia positions are Guide's business, not ours.** `findMissingNamedImports` projects a fence
through `extractSourceLines` before handing it to `fenceImports`, which moves the check's boundary in
both directions relative to reading the fence verbatim. Which exact trivia positions move it belongs
to Guide, so the suite pins them in fences rather than asserting them as universals in the helper's
TSDoc. The raw-versus-projected **comparison** lives in one row; the projected-side controls that
finding 2 separately mandates — single-line, multiline, and alias — live in their own rows, and a
Guide upgrade can surface in any of them.

**The core-face scope-guard invariant.** State it as an invariant, never as a count of rows:

> **Any parity row whose expectation names `createMCPRoutes` against `@orkestrel/mcp` is a live
> core-face scope guard.** `createMCPRoutes` is declared only in `src/server`, so widening
> `src/core` to swallow the server module makes it resolvable and collapses that expectation to `[]`.

Most rows satisfying it carry no label saying so. **Do not
enumerate them here** — an enumeration goes stale the moment a row is added, and a stale count reads
as permission to edit every row it omits. Changing a specifier or a symbol in _any_ row matching the
invariant silently disarms a scope guard.

**Upstream Guide limitation, latent in this corpus.** `fenceImports`'s grammar is
`/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gs` (Guide 0.0.9 dist `index.js:681`).
Read it literally rather than paraphrasing it: the literal `import`, **at least one whitespace**, then
optionally `type` **followed by at least one whitespace**, then `{`. Two consequences a paraphrase
keeps losing — `import type{X}from'…'` is **not** matched (the `type` alternative needs its own
trailing whitespace), and because `import` carries **no word boundary**, a string containing
`reimport { X } from '@src/core'` **is** matched and throws. The set therefore **overlaps** named-brace
imports rather than being a subset of them: it misses real imports and admits text that is not an
import at all. A **mixed default-and-named import** —
`import MCPServer, { createMCPRoutes } from '@src/core'` — is therefore a named import the gate never
sees, as are a whitespace-free brace and a dynamic `import()`. `fenceImports` should surface the mixed
form and does not. **No fence in `guides/` uses any of these, so the hole is real but latent, not a
firing defect.** Guide 0.0.9 is fixed for this campaign, so it is recorded in the
`findMissingNamedImports` TSDoc and pinned by the parity row `records example import forms no
refusal reaches`; **raise it against Guide separately.** Per finding 2 below, no local parser was added,
Guide's grammar was not forked, and the membership claim was not widened — an earlier round breached
that constraint and was reverted.

## Immediate checkpoint: accept Guide-in-MCP before V

Round 96 mechanical conformance passed in
[`96d-guide-repair-conformance-report.md`](tmp/mcp-hardening-20260807/96d-guide-repair-conformance-report.md),
while correctness and design-fit falsification failed in
[`96a-guide-repair-correctness-report.md`](tmp/mcp-hardening-20260807/96a-guide-repair-correctness-report.md)
and [`96b-guide-repair-designfit-report.md`](tmp/mcp-hardening-20260807/96b-guide-repair-designfit-report.md).
Conformance does not override falsification. The next serial repair unit owns all four retained
findings:

1. **Make the face-boundary negative control load-bearing.** The current masking fixture proves
   aggregate collapse but is detached from the live per-face gate. Drive live faces and the
   negative fixture through one visible comparison carrier with explicit expected per-face
   differences. The fixture must fail if that live carrier is weakened. Preserve per-face
   nonempty/direct-to-barrel comparisons and aggregate barrel-to-Guide comparison only.
2. **Compose Guide's comment-aware source projection.** Raw Guide 0.0.9 `fenceImports` drops named
   bindings containing comment trivia. Root proved that
   `extractSourceLines(fence).map((line) => line.code).join('\n')` before `fenceImports` retains
   block- and line-commented bindings. Reuse those exported Guide primitives in the centralized
   test helper and add permanent commented single-line, multiline, and alias controls. Add no local
   parser/compiler, do not fork Guide grammar, and do not widen the named-import-only claim.
3. **Make stopped state win after hostile snapshotting.** Finite `-1` is valid progress. Use `NaN`,
   `Infinity`, and `-Infinity` as invalid controls. If hostile Proxy reflection aborts while
   snapshotting, `report()` must reject as stopped before invalid-progress selection, commit no
   slot/marker, and leave subsequent `take()` stopped.
4. **Leave no hostile hook between the final stop check and atomic state installation.** A Proxy
   can currently defer abort by replacing mutable `Promise.withResolvers`, allowing partial state
   and an unresolved promise to survive `stop()`. The repair must prevent user-controlled work in
   that interval. The regression must reproduce the deferred hook, bound settlement, assert that
   no slot or marker survives, and prove subsequent `take()` rejects as stopped.

First create one reconciled successor design. Then one serial writer adds type-correct failing
proofs, records the exact command and failing counts, makes the smallest repair, and runs the
identical commands green. Preserve the already confirmed I94 results: watchdog ownership, real HTTP
cleanup, exact faces/package keys, the four public declarations, the named-import-only boundary,
Guide dependency/mirror identity, and absent `buildCallResult`.

After implementation, require independent objective and design-fit falsification, mechanical
conformance, and one verifier. Mark this row complete only when all four attacks are bound and no
substantiated successor finding remains.

## Binding sequence after Guide closure

1. **Finish and accept V.** Root-reverify the four historical whole-V findings listed in the
   ledger. Repair only live defects, then independently accept the complete V boundary.
2. **Implement and accept S00/L01.** Land the accepted invocation/notification, result/error, and
   stream contracts types first. Do not add an optional-ID or request-yielding bridge.
3. **Implement and accept modern W01-W06 serially with their assigned S/L carriers.** Keep the
   canonical core sessionless; close each types, server, Tasks, client, Node, and browser unit
   before the next. S01-S05/L02-L06 are acceptance carriers inside this work, not an overlapping
   implementation campaign.
4. **Implement and accept W07.** Extract the removable legacy translator over the sole accepted
   backend and prove fail-closed loss behavior.
5. **Execute W08.** Inspect built declarations and package contents; prove isolated consumers;
   drive representative real foreign modern and legacy surfaces; align guide/parity; run final
   audits and gates.

The ownership crosswalk is binding:

| Carrier                               | Sole implementation owner   | Boundary                                                                                                                                                                       |
| ------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S00/L01                               | Standalone precursor        | Exact invocation/response arms and structural notification-stream/resolved-option contract only.                                                                               |
| Remaining modern contract             | W01                         | All remaining modern types and naming after S00/L01; integrate without silently reopening the accepted precursor.                                                              |
| S01-S05 and L02-L03/L05               | W02                         | Server ownership/containment, MRTR, server stream cancellation/wrapping, reporter behavior, and their direct guide/proof obligations.                                          |
| Task reuse of accepted S/L seams      | W03                         | Task/provider behavior only; reuse the accepted mechanisms rather than duplicating them.                                                                                       |
| Client reuse of accepted stream seams | W04                         | Modern client/task-client duplex binding and client cancellation only; no second L02 engine.                                                                                   |
| L04                                   | W05                         | Shared routing, serialization, pump, Node HTTP lifecycle, and disconnect behavior.                                                                                             |
| Browser parity with L04               | W06                         | Browser adapter and real-host parity proof only; no second L04 mechanism.                                                                                                      |
| L06                                   | W02, bounded to core/server | Core/server lifecycle and guide/API proof. W05/W06 own only documentation/proofs introduced by their transport surfaces; W08 aggregates final parity without reimplementation. |

## Dirty-worktree custody

The dirty tree is intentional campaign and user custody, not cleanup debt. Freeze 95 records the
pre-roadmap inventory and six Guide-repair subject hashes. The exact augmented baseline when this
roadmap was created is that inventory plus exactly `?? ROADMAP.md`; the roadmap is the sole
intentional status addition from this documentation unit. Any additional unexplained status or hash
delta still stops work. See
[`95-guide-repair-freeze.md`](tmp/mcp-hardening-20260807/95-guide-repair-freeze.md).

Most critically, the index contains a staged deletion of `package-lock.json`, while the working tree
contains an untracked **75,446-byte** replacement with SHA-256
`6F915C9B2B2D6A5DADAF148422C8FD6F7926309BE2021D86D638701934E576CA`. This split is user-owned.
Do not reset, restore, checkout, clean, stage, unstage, delete, regenerate, rewrite, or install over
it. Never infer ownership from tracked, staged, or untracked status.

Before every writer, capture `git status --short`, branch/HEAD, named-file hashes, and the scoped
diff. Stop on unexplained divergence. Each writer owns only paths named in its brief and preserves
unrelated edits byte-for-byte. Do not use a tree-wide mutating formatter. Known earlier full-format
drift was confined to `src/core/MCPClient.ts`, `src/core/MCPServer.ts`, `src/core/parsers.ts`, and
`tests/src/core/validators.test.ts`; that is later convergence evidence, not authorization to alter
them during the Guide checkpoint.

## Restart checklist

1. Read [`AGENTS.md`](AGENTS.md), the documentation and quality rules, the package-hardening skill
   plus `centralization.md`/`hardening.md`, and then this roadmap.
2. Read the architecture and sequence evidence:
   [`00-evidence-packet.md`](tmp/mcp-hardening-20260807/00-evidence-packet.md),
   [`07-reconciled-design.md`](tmp/mcp-hardening-20260807/07-reconciled-design.md),
   [`22c-s-boundary-design-reconciliation.md`](tmp/mcp-hardening-20260807/22c-s-boundary-design-reconciliation.md),
   [`29c-v-wire-ownership-repair-design-reconciliation.md`](tmp/mcp-hardening-20260807/29c-v-wire-ownership-repair-design-reconciliation.md),
   [`40-two-stage-publish-plan.md`](tmp/mcp-hardening-20260807/40-two-stage-publish-plan.md), and
   [`80-mcp-resume-registry.md`](tmp/mcp-hardening-20260807/80-mcp-resume-registry.md).
3. For the immediate unit, read
   [`93-guide-repair-reconciliation.md`](tmp/mcp-hardening-20260807/93-guide-repair-reconciliation.md),
   [`94-guide-repair-implementation-report.md`](tmp/mcp-hardening-20260807/94-guide-repair-implementation-report.md),
   the Freeze-95 file, and the three Round-96 reports linked above. Read the six frozen subject
   files completely.
4. Reverify the dated official MCP authority. Then run these read-only custody checks:

   ```text
   git status --short
   git branch --show-current
   git rev-parse HEAD
   npm ls @orkestrel/guide --depth=0
   ```

   Also verify the six Freeze-95 hashes, the installed/mirrored Guide hashes, and the split
   lockfile size/hash. Compare status with Freeze 95 plus exactly `?? ROADMAP.md`. Stop on any
   additional unexplained divergence; do not normalize it.

5. Reproduce all four immediate findings. The exact first work action is a successor design and
   tests-first repair unit for those findings. Do not start V, S00, Tasks, legacy, or consumers.
6. Run the narrow evidence commands as applicable:

   ```text
   npm run test:guides
   npm run test:src:core -- tests/src/core/MCPProgressReporter.test.ts tests/src/core/cloners.test.ts tests/src/core/helpers.test.ts
   npm run test:src:server -- tests/src/server/transports/HTTPDisconnect.test.ts tests/src/server/handlers.test.ts tests/src/server/middlewares.test.ts
   npm run check
   npm run lint:check
   git diff --check
   ```

   Use only non-mutating scoped format checks during the dirty campaign.

7. The latest scoped baseline was Guide **62/62**, focused core **62/62**, focused server **58/58**,
   plus green check, lint, scoped format, and diff-check. These counts are baselines, not acceptance
   or whole-package publication proof.
8. After each accepted unit, update its ledger row with exact red/green commands and counts, audit
   verdicts, the last evidence, and the next first non-green action. Promote any durable conclusion
   from `tmp/` into this file before campaign evidence is swept.

## Acceptance definition

A ledger row becomes **complete** only when its types, implementation, tests, barrels, guide,
examples, mirrors, declarations, and generated output agree as applicable; each defect has an exact
type-correct red proof and identical green rerun; hostile input, cancellation, concurrency, partial
failure, cleanup, ownership, bounds, and environment seams have real evidence; and every retained
finding has an explicit carrier and closure.

The writer does not accept its own work. Require independent objective and design-fit/adversarial
review, mechanical conformance, and one verifier. For security, concurrency, or hostile-input work,
the independent reviews must try to falsify numbered claims. A conformance pass or scoped green
command never overrides a falsification failure.

W08 additionally requires built-package declaration/export/content inspection, real isolated
consumers rather than source aliases, representative foreign modern and legacy clients, honest
interoperability limits, and package dry-run inspection. Final non-mutating gates run in this exact
order, and their exit codes and output are read:

```text
npm run format:check
npm run lint:check
npm run check
npm run build
npm test
```

## Explicit exclusions

- This roadmap authorizes no publish, commit, push, tag, install, dependency change, staging,
  reset, cleanup, symlink, override, or lockfile rewrite.
- Do not couple MCP architecture to `tool`, `workflow`, `toolbox`, or `supervisor`.
- Do not add a local parser/compiler/reflection duplicate or fork Guide's import parser when its
  published primitives compose to the required behavior.
- Do not add pseudo-Tasks, MRTR or Task-progress replay, a second legacy execution engine, hidden
  modern session state, or polling as package architecture/source of truth.
- Do not leave a current-scope TODO, skipped test, type-error test, deferred defect, compatibility
  shim, hidden helper, naming violation, or centralization exception.
- Do not begin Tasks, legacy, consumer, or final-gate work while Guide, V, or S00 predecessors are
  non-green.
- Do not claim publication readiness from Guide 62, core 62, server 58, check, lint, scoped format,
  an implementation report, or conformance alone.

## Evidence index

- Research and architecture: [`00-evidence-packet.md`](tmp/mcp-hardening-20260807/00-evidence-packet.md),
  [`07-reconciled-design.md`](tmp/mcp-hardening-20260807/07-reconciled-design.md).
- V and S boundaries: [`27f-v-wire-repair-acceptance-reconciliation.md`](tmp/mcp-hardening-20260807/27f-v-wire-repair-acceptance-reconciliation.md),
  [`29c-v-wire-ownership-repair-design-reconciliation.md`](tmp/mcp-hardening-20260807/29c-v-wire-ownership-repair-design-reconciliation.md),
  [`22c-s-boundary-design-reconciliation.md`](tmp/mcp-hardening-20260807/22c-s-boundary-design-reconciliation.md).
- Sequence and consumers: [`23-alignment-campaign-registry.md`](tmp/mcp-hardening-20260807/23-alignment-campaign-registry.md),
  [`40-two-stage-publish-plan.md`](tmp/mcp-hardening-20260807/40-two-stage-publish-plan.md),
  [`80-mcp-resume-registry.md`](tmp/mcp-hardening-20260807/80-mcp-resume-registry.md).
- Guide release and dependency: [`78-guide-0.0.9-publish-handoff.md`](tmp/mcp-hardening-20260807/78-guide-0.0.9-publish-handoff.md),
  [`87c-guide-mirror-sync-report.md`](tmp/mcp-hardening-20260807/87c-guide-mirror-sync-report.md).
- Immediate checkpoint: [`93-guide-repair-reconciliation.md`](tmp/mcp-hardening-20260807/93-guide-repair-reconciliation.md),
  [`94-guide-repair-implementation-report.md`](tmp/mcp-hardening-20260807/94-guide-repair-implementation-report.md),
  [`95-guide-repair-freeze.md`](tmp/mcp-hardening-20260807/95-guide-repair-freeze.md), and the Round-96 reports linked above.
- Roadmap design: [`98a-roadmap-objective-report.md`](tmp/mcp-hardening-20260807/98a-roadmap-objective-report.md),
  [`98b-roadmap-designfit-report.md`](tmp/mcp-hardening-20260807/98b-roadmap-designfit-report.md), and
  [`99-roadmap-reconciliation.md`](tmp/mcp-hardening-20260807/99-roadmap-reconciliation.md).
- Roadmap acceptance and repair: [`100a-roadmap-correctness-report.md`](tmp/mcp-hardening-20260807/100a-roadmap-correctness-report.md),
  [`100b-roadmap-designfit-report.md`](tmp/mcp-hardening-20260807/100b-roadmap-designfit-report.md),
  [`100c-roadmap-conformance-report.md`](tmp/mcp-hardening-20260807/100c-roadmap-conformance-report.md),
  and [`101-roadmap-repair-reconciliation.md`](tmp/mcp-hardening-20260807/101-roadmap-repair-reconciliation.md).
- Roadmap successor repair: [`102a-roadmap-correctness-report.md`](tmp/mcp-hardening-20260807/102a-roadmap-correctness-report.md),
  [`102b-roadmap-designfit-report.md`](tmp/mcp-hardening-20260807/102b-roadmap-designfit-report.md),
  [`102c-roadmap-conformance-report.md`](tmp/mcp-hardening-20260807/102c-roadmap-conformance-report.md),
  and [`103-roadmap-final-reconciliation.md`](tmp/mcp-hardening-20260807/103-roadmap-final-reconciliation.md).
- Roadmap terminal acceptance: [`104a-roadmap-correctness-report.md`](tmp/mcp-hardening-20260807/104a-roadmap-correctness-report.md),
  [`104b-roadmap-designfit-report.md`](tmp/mcp-hardening-20260807/104b-roadmap-designfit-report.md), and
  [`104c-roadmap-conformance-report.md`](tmp/mcp-hardening-20260807/104c-roadmap-conformance-report.md).
- Roadmap verifier reconciliation: [`105-roadmap-verifier-report.md`](tmp/mcp-hardening-20260807/105-roadmap-verifier-report.md)
  and [`106-roadmap-verifier-reconciliation.md`](tmp/mcp-hardening-20260807/106-roadmap-verifier-reconciliation.md).
