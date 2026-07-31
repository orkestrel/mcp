# PROPOSAL — MCP 2026-07-28 adoption and multi-version support

> **Status:** the 2026-07-28 adoption is **not implemented**; the §3 conformance fixes are
> shipped and published. `MCP_PROTOCOL_VERSION` is still `'2025-06-18'` and
> `SUPPORTED_PROTOCOL_VERSIONS` is still `['2025-06-18']` (`src/core/constants.ts:7,19`), so
> nothing in §4–§6 describes behavior that ships today.
> **Evidence date:** 2026-07-31. **Baseline:** `1209eb5` on `main`; package.json **0.0.8,
> published**.
>
> Produced 2026-07-28 from live primary-source research and a full adversarial design pass
> (Opus 5 planner vs GPT-5.6 Sol analyst on the same brief, reconciled by the orchestrator).
> The 2026-07-28 adoption itself was deferred to a dedicated session by the owner's decision.
> Baseline when written: `b77ee07` (branch + main), version 0.0.6 unpublished. Replaces the
> previous PROPOSAL.md (environment-agnostic faces), which shipped fully with 0.0.6 and
> remains in git history at `a2f983b`. This document is self-contained; the session journals
> behind it were ephemeral.
>
> **Update, later 2026-07-28 — current-version conformance fixes shipped.** §3 defects 1, 2,
> 3, and 5 are fixed on this branch as 0.0.6 content, independently audited (Opus design-fit,
> Sol correctness, mechanical checker) and verified green on all five gates including the
> real-Chromium browser suite. §3.4 and §3.6 remain intentionally deferred to the adoption.
> Consequences for the plan below: `SUPPORTED_PROTOCOL_VERSIONS` is now `['2025-06-18']`
> (§4.2's removal of 2025-03-26 is done; the three-revision expansion remains adoption
> work); the batch arm of `ClientTransportInterface.send` is already deleted (drop it from
> U0's content); `src/core/errors.ts` with `MCPError`/`isMCPError` already exists (U1
> extends rather than creates it); `MCPClientInterface` already exposes the negotiated
> revision as `protocol` (the adoption's §4.3/§9.5 naming decision applies on top); the
> `MCP-Protocol-Version` header is live end to end with capture gated to supported versions
> and cleared on transport `close()` (U4/U5 keep only `Mcp-Method`/`Mcp-Name` and the
> status-map work).
>
> **Amendment, 2026-07-31 — a named consumer arrives.** That branch is merged and its content
> is published (it landed before the 0.0.7 bump and ships in 0.0.8).
> **`@orkestrel/supervisor`** — the durable, detached, human-in-the-loop workflow supervisor
> proposed in the workflow repository's `PROPOSAL.md` — is now the **first named consumer** of
> this adoption, and it consumes several mechanisms §5 excluded precisely for want of such a
> consumer. Its own design questions were settled by a separate two-round adversarial pass
> whose orchestrator verdict is binding here and is not re-litigated: MCP targets
> **2026-07-28 (modern) first** for that projection; the durable handle is **a durable id in
> an ordinary `tools/call` result**, on every era, with no capability negotiation; the Tasks
> extension is **optional augmentation, never the substrate**; MRTR cannot push a later input
> request into an already-completed call; the MCP server needs an independent service host;
> and there are **no resources in the first slice**. The consequences are recorded in §5.1
> (flipped exclusions and newly surfaced gaps), §6.1–§6.2 (the amendment units), §7 (version
> context), and §8.8–§8.11 (new evidence tasks). §1's verified research, §3's defects, §4's
> design spine — **including §4.2's supported-revision ruling, which is unchanged** — and §9's
> adversarial record stand as written.
>
> **Correction pass, 2026-07-31 (post-amendment audit).** Seven defects were substantiated
> against source and are fixed in place below. Four are **pre-existing** — written before the
> amendment and missed by it: §4.2/§4.8's headerless-legacy-POST default, which contradicted
> §1.2's scoped permission (withdrawn in §4.2); §5's `Mcp-Param-*` row, which called an unmet
> client-side MUST an exclusion (now a **declared conformance gap**, not a non-goal); §4.8's
> "three headers on every POST", which over-applied `Mcp-Name` (§1.4.6 binds it to three named
> methods); and U0/U1 rows scheduling work that already shipped in 0.0.8. Three were
> **introduced by the amendment**: the discriminator's presence-vs-string contradiction
> (§4.1/§4.5), A4's supersession acceptance criterion standing ahead of the §8.10 evidence that
> establishes it, and the absent handler/dispatch signatures that A4 and A5 both require (now
> specified in §4.3). Nothing below describes shipped behavior; the status line above governs.
>
> **Evidence pass, 2026-07-31 — §8 run against primary sources.** Eleven of the twelve evidence
> tasks returned, read from the spec text and the commit-pinned schema rather than from prose
> summaries; only §8.2 was outside this pass and stays open. Seven findings **contradicted**
> this document and are fixed in place: §4.2's three-item 2025-11-25 mandatory surface — one
> item refuted, several unrecorded MUSTs added, one of them a second declared conformance gap
> (§4.2, §5.1.10); `ttlMs`'s optionality and the reading of `0` (§4.4); a `-32020` `data` shape
> that does not exist (§4.4); MRTR's `inputRequests` shape, `requestState` type, and echo
> position (§5.1.1); A4's supersession rule, **withdrawn** because MCP defines no subscription
> key for it to govern (§5.1.2, §6.2); §8.6's "no reference peer exists", overturned by a
> published conformance suite; and the batching MUST's citation page (§8.1). Six more findings
> **filled gaps** this document simply did not know: `tools/list` owes both `ttlMs` and
> `cacheScope` (§4.4); elicitation modes are capability-gated and `InputRequiredResult` is
> method-restricted (§5.1.1); a subscription's closing frame carries a required `_meta`, and
> stream ordering is per subscription id rather than per channel (§5.1.2); the headerless-POST
> rule now has three settled cases and the spec clause that settles them (§4.2, §4.8); A7's
> stated trigger has fired and is re-ruled rather than ignored (§5.1.3); and `CallToolResult`
> shares its response slot with `InputRequiredResult` (§8.8). §8 now carries an answer and a
> status per task instead of a question.

## Why this exists

The MCP project published revision **2026-07-28** (served at `/specification/latest`). It is
a clean architectural break — "stateless MCP" — that removes the `initialize` handshake,
sessions, the HTTP GET stream, SSE resumability, and all server-initiated requests, replacing
negotiation with per-request `_meta` and a mandatory `server/discover` method. This package
implements **2025-06-18** (nominally negotiable down to 2025-03-26) and has never absorbed
**2025-11-25**. Adopting 2026-07-28 touches the negotiation surface, both client faces, the
server middlewares, every transport, and the guide — hence a dedicated implementation session.

---

## 1. Verified research (live, primary sources, 2026-07-28)

### 1.1 Revision ledger

| Revision   | Status                                                                           | Theme                                                                                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2024-11-05 | Final                                                                            | Initial release: initialize handshake, stdio + HTTP+SSE transport.                                                                                                                                                                                                                    |
| 2025-03-26 | Final                                                                            | Streamable HTTP replaces HTTP+SSE; JSON-RPC batching ADDED; OAuth 2.1.                                                                                                                                                                                                                |
| 2025-06-18 | Final                                                                            | Batching REMOVED; structured tool output; elicitation; `MCP-Protocol-Version` header required on post-initialize HTTP requests; `_meta` formalized.                                                                                                                                   |
| 2025-11-25 | Site's versioning page still labels it "current"                                 | Icons; URL-mode elicitation; sampling tool calls; experimental core tasks; SSE polling; JSON Schema 2020-12 default.                                                                                                                                                                  |
| 2026-07-28 | Newest published; `/specification/latest` serves it; sole revision in `llms.txt` | **Stateless MCP**: handshake, sessions, GET stream, SSE resumability, server-initiated requests all removed; per-request `_meta` version/capabilities; `server/discover`; MRTR; `subscriptions/listen`; `resultType`; tasks moved to an extension; roots/sampling/logging deprecated. |

### 1.2 Modern era (2026-07-28) negotiation

- **No handshake.** `initialize` / `notifications/initialized` are removed. Every request
  carries in `params._meta`: `io.modelcontextprotocol/protocolVersion` (REQUIRED) and
  `io.modelcontextprotocol/clientCapabilities` (REQUIRED); `io.modelcontextprotocol/clientInfo`
  SHOULD. Servers judge each request independently — they MUST NOT infer version,
  capabilities, or identity from prior requests on the same connection.
- Unsupported version → JSON-RPC `-32022` `UnsupportedProtocolVersionError` with
  `error.data = { supported: [...], requested: '...' }`; the client SHOULD pick from
  `supported` and retry under a NEW request id. No counter-offer mechanism.
- Missing `_meta` requireds → `-32602` (HTTP 400). Missing needed client capability →
  `-32021` `MissingRequiredClientCapabilityError` (`data.requiredCapabilities`, HTTP 400).
- **`server/discover`** is a mandatory server RPC: result carries `supportedVersions`,
  `capabilities`, optional `instructions`, `ttlMs`, `cacheScope`,
  `_meta['io.modelcontextprotocol/serverInfo']`, `resultType: 'complete'`. Clients MAY use it
  for up-front version selection.
- `MCP-Protocol-Version` HTTP header: required on every POST since 2025-06-18; in 2026-07-28
  it MUST equal the body's `_meta` version — mismatch → HTTP 400 + `-32020` `HeaderMismatch`.
  Headerless MAY be treated as 2025-03-26 only by servers that still serve pre-2025-06-18
  clients.

### 1.3 2025-11-25 delta vs 2025-06-18 (the missing legacy rung)

- **Experimental core tasks**: `tasks/get`, `tasks/result` (blocking), `tasks/list`,
  `tasks/cancel`; `notifications/tasks/status`; request augmentation `params.task: { ttl }`;
  `CreateTaskResult`; statuses `working | input_required | completed | failed | cancelled`;
  capabilities `tasks.*`; tool-level `execution.taskSupport`; `_meta`
  `io.modelcontextprotocol/related-task`.
- **URL-mode elicitation** (`mode: 'url'`, `elicitationId`, companion
  `notifications/elicitation/complete`, error `-32042`) — all retired again in 2026-07-28.
- Sampling tool calls (`tools`/`toolChoice` on `sampling/createMessage`); icons on
  Tool/Prompt/Resource/Implementation; `Implementation.description`; elicitation enum-schema
  restructure + defaults.
- Transport: SSE polling (priming event with id + empty data; server MAY close the connection
  without ending the stream, SHOULD send `retry` first; resumption is ALWAYS GET +
  `Last-Event-ID`); invalid `Origin` → 403 (MUST); stdio stderr for all log levels.
- Tool input validation errors SHOULD be execution errors (`isError: true`), not protocol
  errors. JSON Schema 2020-12 becomes the default dialect.
- Sessions unchanged from 2025-06-18 (`Mcp-Session-Id` at initialize; missing → 400;
  expired → 404 + re-initialize; DELETE to end, server MAY 405).

### 1.4 2026-07-28 delta vs 2025-11-25

**Removed** (breaking): `initialize`, `notifications/initialized`, `ping`,
`logging/setLevel`, `notifications/roots/list_changed`, `resources/subscribe|unsubscribe`
(→ `subscriptions/listen`), all server-initiated requests (roots/sampling/elicitation now
travel inside MRTR results), protocol sessions + `Mcp-Session-Id`, the HTTP GET stream, SSE
resumability, core tasks (→ `io.modelcontextprotocol/tasks` extension), client→server
notifications over HTTP (`notifications/cancelled` is stdio-only — on HTTP, closing the SSE
response stream IS the cancellation signal). Modern-only servers answer GET/DELETE `405`.

**Added/changed**:

1. Per-request `_meta` reserved keys (§1.2) plus `io.modelcontextprotocol/logLevel`
   (per-request log opt-in — servers MUST NOT emit `notifications/message` for requests that
   did not include it), `io.modelcontextprotocol/subscriptionId`,
   `io.modelcontextprotocol/serverInfo` (SHOULD on results), W3C `traceparent`/`tracestate`/
   `baggage`. Any `_meta` prefix whose second label is `modelcontextprotocol` or `mcp` is
   reserved.
2. `server/discover` (mandatory).
3. **`resultType` required on every result**: `'complete' | 'input_required'` (extensions may
   add values, e.g. `'task'`). Absent → treat as `'complete'` (older servers).
4. **MRTR**: `InputRequiredResult = { resultType: 'input_required', inputRequests?,
requestState? }`, allowed only on `tools/call`, `resources/read`, `prompts/get`;
   `inputRequests` maps server keys → `ElicitRequest | CreateMessageRequest |
ListRootsRequest` (only types the client declared); client retries the ORIGINAL request
   with a NEW id adding `inputResponses` and echoing `requestState` byte-exact (opaque;
   attacker-controlled from the server's view — integrity-protect if it matters).
5. **`subscriptions/listen`**: held-open response stream; first message per subscription is
   `notifications/subscriptions/acknowledged`; every stream notification carries
   `_meta['io.modelcontextprotocol/subscriptionId']` = the listen request's id; graceful
   closure is a complete result carrying a **required** `_meta` with that same subscription id
   (**corrected 2026-07-31** from "empty complete result" — see §5.1.2).
6. **Required HTTP metadata headers**: `Mcp-Method` (= body method) on all requests;
   `Mcp-Name` (= `params.name`/`params.uri`) on `tools/call`, `resources/read`,
   `prompts/get`; `MCP-Protocol-Version` on all. Optional `Mcp-Param-{Name}` via
   `x-mcp-header` schema annotation (primitives, no numbers; clients MUST support and MUST
   exclude invalid tool definitions from `tools/list`). Non-ASCII → `=?base64?...?=`.
   Mismatch/missing → HTTP 400 + `-32020` `HeaderMismatchError`.
7. HTTP codes: 202 notification accepted; 400 header mismatch / unsupported version /
   missing capability / malformed `_meta`; 403 invalid Origin; **404 + JSON-RPC `-32601` for
   unknown method**; 405 GET/DELETE. `X-Accel-Buffering: no` SHOULD on SSE; SSE comment
   keep-alives encouraged.
8. Error code policy: `-32000..-32019` grandfathered implementation range;
   `-32020..-32099` spec-reserved. Defined: `-32020` HeaderMismatch, `-32021`
   MissingRequiredClientCapability, `-32022` UnsupportedProtocolVersion. Retired (MUST NOT
   emit): `-32002` (resource-not-found → `-32602`), `-32042`.
9. **`CacheableResult`**: `ttlMs` + `cacheScope` (`'public' | 'private'`) REQUIRED on results
   of `tools/list`, `prompts/list`, `resources/list`, `resources/read`,
   `resources/templates/list`, `server/discover`. `tools/list` SHOULD be deterministically
   ordered.
10. `extensions` map on ClientCapabilities/ServerCapabilities (reverse-DNS ids).
11. **Tasks extension** (`io.modelcontextprotocol/tasks`): server MAY return
    `CreateTaskResult` (`resultType: 'task'`) unsolicited; `tasks/get`, `tasks/update` (new),
    `tasks/cancel`; core `tasks/list` and blocking `tasks/result` REMOVED; `ttl` → `ttlMs`,
    `pollInterval` → `pollIntervalMs`.
12. Roots, Sampling, Logging DEPRECATED (12-month window); HTTP+SSE transport deprecated;
    RFC 7591 DCR deprecated for Client ID Metadata Documents.
13. Statelessness doctrine: body is a SINGLE request or notification (no batching, still);
    clients MUST NOT POST JSON-RPC responses.

### 1.5 Dual-era guidance (from the spec itself)

- "Clients and servers MAY support multiple protocol versions simultaneously." Eras:
  **Modern** (2026-07-28+), **Legacy** (2025-11-25 and earlier, initialize-based),
  **Dual-era** (both).
- **Dual-era server**: an `initialize` request selects legacy semantics for that stdio
  process / HTTP session (keep `Mcp-Session-Id` and legacy negotiation); a request carrying
  modern per-request `_meta` is served statelessly per 2026-07-28. Both eras may coexist on
  one endpoint.
- **Dual-era client**: stdio — try `server/discover`, fall back to `initialize` on a
  non-modern error/timeout. HTTP — attempt modern; on 400 inspect the body: recognized
  modern error → stay modern (retry from `supported`); else fall back to `initialize`. Cache
  the era per server/origin.
- Modern-only servers SHOULD name their supported versions in the error they return to any
  `initialize` request.

### 1.6 Source URLs (all fetched successfully during research)

- https://modelcontextprotocol.io/specification/versioning
- https://modelcontextprotocol.io/specification/2026-07-28 (= `/specification/latest`)
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- https://modelcontextprotocol.io/specification/2026-07-28/basic
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/extensions/tasks/overview
- https://modelcontextprotocol.io/specification/2025-11-25/changelog
- https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-06-18/changelog
- https://modelcontextprotocol.io/specification/2025-03-26/changelog

Unverified at depth: 2024-11-05's own pages (attested via cross-references); the ext-tasks
repo's per-method wire shapes beyond the overview page; the exact 2025-11-25 URL-elicitation
field list beyond `mode`/`elicitationId`.

---

## 2. Current package inventory (verified at b77ee07)

- **Faces**: `src/core` (host-independent `MCPClient`/`MCPServer`, port binders,
  validators/parsers), `src/server` (Node: `createMCPRoutes`, `createMCPSession` +
  `MCPSession`, WebSocket server/client transports, stdio transports, HTTP client transport),
  `src/browser` (`HTTPClientTransport` over fetch, `WebSocketClientTransport`,
  `MessagePortTransport`, `serveMCP`).
- **Method surface**: `initialize`, `ping`, `tools/list`, `tools/call`,
  `notifications/initialized`; session-level `notifications/message`.
- **Version surface** (fully centralized):
  - `src/core/constants.ts:7` — `MCP_PROTOCOL_VERSION = '2025-06-18'`;
    `SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26']` (frozen).
  - `initializeResult` (`src/core/helpers.ts:120`) — echo-if-supported else default.
  - `MCPServer.dispatch` `initialize` arm — `src/core/MCPServer.ts:100`.
  - `MCPClient.connect` — sends the pinned version (`src/core/MCPClient.ts:118`).

## 3. Defects and gaps found (stand regardless of adoption; all source-verified)

Status: items 1, 2, 3, and 5 are **FIXED** on this branch (see the status update at the
top); items 4 and 6 remain open by design, resolved by the adoption. The descriptions below
are preserved as written at proposal time — the cited lines describe the pre-fix state.

1. **FIXED** — **`MCP_PROTOCOL_VERSION_HEADER` is dead code** — declared at `src/server/constants.ts:24`,
   referenced tree-wide only by its own declaration and one guide row. 2025-06-18+ REQUIRES
   HTTP clients to send `MCP-Protocol-Version` on every post-initialize request and servers
   to validate it. Neither client face sends it; no middleware reads it.
2. **FIXED** — **The client ignores the negotiated version** — `MCPClient.connect` discards the entire
   `initialize` result: no validation, no disconnect-on-unsupported (the spec's rule), and
   the negotiated version is unavailable to the transport layer (which needs it for gap 1).
3. **FIXED** — **2025-03-26 support is overclaimed** — it sits in `SUPPORTED_PROTOCOL_VERSIONS`, but that
   revision's JSON-RPC batching is not implemented: `parseJSONRPCMessage`
   (`src/core/parsers.ts:24`) narrows via `isJSONRPCMessage` and rejects arrays;
   `MCPServer.handle` answers a batch with `-32600`. Only outbound transport signatures
   nominally accept arrays (`ClientTransportInterface.send`), a capability no caller uses.
4. **Open (adoption)** — **`createMCPSession` would 404 every modern stateless request**
   (`src/server/middlewares.ts:129-138`): a POST that neither carries a known session id nor
   parses as `initialize` is rejected. A 2026-07-28 request satisfies neither. Highest-value
   single fix in the adoption.
5. **FIXED** — **`MCPError` structure is unreachable** — remote failures become stringly-typed `Error`s
   (`MCPClient` `#settle`), so `error.code`/`error.data` are lost; the modern `-32022` retry
   (which must read `data.supported`) is impossible today.
6. **Open (adoption)** — Dead declarations: `MCPServerInfo` (`src/core/types.ts:105`)
   exported but unused; `MCPServerOptions.description` declared "reserved" and unused.
   Resolved by U0's `MCPIdentity` regrouping.

---

## 4. Reconciled design

Produced by reconciling two independent adversarial designs (planner = Opus 5, subjective;
analyst = GPT-5.6 Sol, objective) run on the same brief. Agreements adopted directly;
divergences ruled by the orchestrator in §9 with dissents preserved.

### 4.1 Era architecture — the spine

- **Era is the wire shape; version is the revision.** Modern = per-request `_meta`
  (2026-07-28). Legacy = `initialize` handshake (2025-11-25, 2025-06-18).
- **The discriminator is structural, per-request, never stored:**

  > A request is modern **iff** the key
  > `params._meta['io.modelcontextprotocol/protocolVersion']` is **present**. Presence of the
  > key, nothing else — not its value, not its type.

  This single rule is load-bearing: a legacy 2025-06-18 request may legally carry
  `_meta.progressToken`, so keying on "`_meta` exists" would misclassify it. Keying on the
  version token keeps legacy `_meta` working and makes "present but incomplete" exactly the
  modern `-32602` case.

  **Presence routes; validity answers.** The discriminator and the validation of what the key
  holds are two steps, and conflating them inverts the outcome: if routing required a _string_
  value, then `_meta[MCP_META_VERSION] = 7` would fall through to the legacy branch and be
  answered as a handshake request, when §1.2 says a modern request with malformed `_meta`
  requireds owes `-32602` (HTTP 400). So step one is `isModernRequest` — key present, era is
  modern, irrevocably. Step two is `parseRequestContext`, modern-scoped, which rejects a
  non-string version, a missing `capabilities`, or any other malformed required with `-32602`.
  A request cannot escape the modern branch by carrying a _bad_ version; only by carrying no
  version key at all.

- Consequences: no era flag on `MCPServer` (one server serves both eras on one endpoint —
  which a dual-era HTTP mount requires anyway); no era in any options bag; the client pins
  with `version`, not `era` (absence ⇒ negotiate); `MCPEra` exists publicly only for the
  `request` event tuple and `inferEra`.
- **Wire-name vocabulary rule** (stated once in `types.ts` and the guide): types that model
  the wire carry the wire's field names verbatim (`resultType`, `ttlMs`, `cacheScope`,
  `supportedVersions`, `_meta`) — exactly as `jsonrpc`, `inputSchema`, and `isError` already
  do; the naming laws bind fully everywhere the library speaks for itself (`identity`,
  `instructions`, `cache.ttl`, `version`, `discover()`, `era`).

### 4.2 Supported revisions (orchestrator ruling)

```ts
export type MCPVersion = '2026-07-28' | '2025-11-25' | '2025-06-18'
export type MCPEra = 'modern' | 'legacy'

export const MCP_PROTOCOL_VERSION: MCPVersion = '2026-07-28'
export const SUPPORTED_PROTOCOL_VERSIONS: readonly MCPVersion[] = Object.freeze([
	'2026-07-28',
	'2025-11-25',
	'2025-06-18',
])
```

| Revision   | Ruling                                             | Why                                                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | **Support — default, modern era**                  | `/specification/latest`; its mandated tools-only surface is fully implementable with zero speculative capability.                                                                                                                                                                                                               |
| 2025-11-25 | **Support — legacy era** (planner dissented; §9.1) | Site-labeled "current"; the dominant deployed client population today. Mandatory delta measured 2026-07-31 and **larger than three items** — see below; all of it satisfied except one declared conformance gap (§5.1.10). Optional surfaces (tasks, icons, URL elicitation, SSE polling) are NOT adopted and never advertised. |
| 2025-06-18 | **Support — legacy era**                           | The currently implemented revision; the legacy anchor the widest older ecosystem speaks.                                                                                                                                                                                                                                        |
| 2025-03-26 | **Remove** (both engines agree; source-verified)   | Advertised today while its batching MUST is violated (§3.3). Delete the row rather than implement batching that 2025-06-18 removed again. Consequence: the headerless default disappears with it — see the ruling below.                                                                                                        |
| 2024-11-05 | **Exclude** (both agree)                           | Requires the HTTP+SSE two-endpoint transport this package never implemented and 2026-07-28 deprecates. Advertising the version without its transport is a false handshake.                                                                                                                                                      |

The list order is meaningful: it is the client's preference order and the `server/discover`
advertisement.

**The 2025-11-25 mandatory surface — measured, and larger than the row claimed (§8.5
answered).** The three-item reading above did not survive its own evidence task. Two items are
confirmed: an invalid `Origin` MUST get 403, and JSON Schema 2020-12 is not one MUST but
**three** — support 2020-12, validate against the declared or default dialect and handle an
unsupported dialect gracefully, and keep the schemas themselves valid. The third item is
**refuted and struck**: `server/tools` § Error Handling carries no server-binding keyword at
all. It is a descriptive classification, and its only keywords bind the _client_, which SHOULD
surface execution errors to the model. "Validation-as-execution-error" was never a MUST on us,
so it no longer appears in the row above and must not reappear in the guide.

The surface is also wider than any three items. A tools-only 2025-11-25 server is additionally
bound to declare the `tools` capability; to keep `inputSchema` a valid JSON Schema object
rather than `null`; to the base protocol and lifecycle in full (an id present on every request
and never `null`, notifications answered with nothing, an integer error `code`; `initialize`
first, the server's capabilities in its response, the version-negotiation response rules, and
both parties respecting the negotiated version and using only negotiated capabilities); to
`security_best_practices` (MUST NOT accept a token not issued for this server, MUST verify
every inbound request, MUST NOT authenticate with sessions, MUST use secure non-deterministic
session ids); and — from `server/tools` § Security Considerations — to validate all tool
inputs, implement proper access controls, **rate limit tool invocations**, and sanitize tool
outputs.

**§9.1 said to revisit if a larger mandatory surface surfaced. It has, and the ruling to keep
2025-11-25 survives.** Every added MUST is either already satisfied by the implementation or is
generic base-protocol and lifecycle behavior this package implements regardless of which
revision it is speaking — with exactly one genuine exposure. **"Rate limit tool invocations" is
a MUST this library does not satisfy**: a rate limit is a decision about a specific caller's
traffic against a specific deployment's capacity, which the mechanism-not-policy law puts with
the consumer, not with the framework. That makes it a **declared conformance gap** in the
§5.1.9 sense — the second one, alongside `Mcp-Param-*` — recorded in §5.1.10 and named in U6's
gaps section with its clause, its consumer-visible consequence, and its closer. A declared gap
is not a reason to drop the revision; it is the honest alternative to a silent omission.

**2025-03-26's removal is ours, not upstream's.** The revision is still live on the spec site
and still one of the six the versioning page lists; nothing was withdrawn. Dropping it is this
library's decision, taken because its batching MUST is unimplemented (§3.3). Neither the row
above nor the guide may read as though the ecosystem retired it.

**Headerless legacy POST — the default is withdrawn (corrects pre-existing text).** The
earlier reading, "a headerless legacy HTTP request is treated as 2025-06-18", was written as a
consequence of removing 2025-03-26 and does not survive §1.2: the research permits treating a
headerless request as a version at all _only_ for servers that still serve pre-2025-06-18
clients, and dropping 2025-03-26 is exactly the decision to stop being one. A REQUIRED header
cannot be defaulted by the same act that removes the only license to default it. **Where the
research and the ruling conflict, the research wins**, so:

- The library **infers no version from an absent header.** There is nothing to infer: the
  legacy branch is revision-invariant on the tools-only surface (§4.6, §9.4), so it answers
  correctly without knowing which legacy revision it is speaking.
- Where a legacy session exists, the version pinned at `initialize` governs (§4.8) — a
  negotiated fact, not a default.
- `initialize` itself is legitimately headerless: 2025-06-18 requires the header on
  _post-initialize_ requests (§3.1), and no version is negotiated before the handshake.
- A header naming an unsupported revision is still `-32022`, unchanged.

**Settled 2026-07-31 (§8.12 answered); the withdrawal was right for the reason it guessed at.**
The paragraph above withdrew the default on caution — a REQUIRED header cannot be defaulted by
the same act that removes the only license to default it — and the primary text turns out to
say precisely that. 2025-06-18 and 2025-11-25 are word-for-word identical here, and the
defaulting SHOULD carries its own scope (bold on the scoping clause is ours; the source bolds
only `SHOULD`):

> For backwards compatibility, if the server does _not_ receive an `MCP-Protocol-Version`
> header, **and has no other way to identify the version - for example, by relying on the
> protocol version negotiated during initialization** - the server **SHOULD** assume protocol
> version `2025-03-26`.

The negotiated version is the clause's own example of having another way, so on a live legacy
session the antecedent is unsatisfied and the `2025-03-26` default never engages at all. That
is exactly the corrected reasoning above — "the version pinned at `initialize` governs, a
negotiated fact, not a default" — now with direct textual support instead of inference. The
adjacent `400` MUST is triggered by an invalid or unsupported header _value_; on a _missing_
header both legacy revisions are silent. 2026-07-28 carries the scoping the earlier reading had
misattributed to them:

> A server that supports clients implementing protocol versions earlier than `2025-06-18`
> (which did not define the `MCP-Protocol-Version` header) **MAY** treat a request that omits
> the header as protocol version `2025-03-26`. A server that does not support such clients
> **MUST** reject a request without the header per Server Validation.

Having removed 2025-03-26, we are in the spec's own words a server that does not support such
clients, and Server Validation resolves to HTTP 400 + `-32020` over a failure list that
explicitly includes a missing required standard header. **The ingress rule, three cases:**

- **Legacy `initialize`** — legitimately headerless; no version is negotiated yet. Accept.
- **Legacy post-`initialize` request on a live session, no header** — accept, and the session's
  negotiated version governs. The legacy text's own scoping says the default does not engage
  precisely because we have another way to know.
- **Any other headerless request** — modern, or legacy with no session to consult — nothing
  identifies the era, so **reject: HTTP 400 + `-32020`**.

Defaulting to 2025-06-18 stays ruled out, now on evidence rather than on caution. U4 ships this
rule and U6 states it as behavior, not as a gap.

### 4.3 Type contracts (`src/core/types.ts`) — planner shape adopted

New: `MCPVersion`, `MCPEra`, `MCPIdentity { name, version }` (replaces unused
`MCPServerInfo`; also groups client identity), `MCPRequestContext { version, capabilities,
identity? }` (the parsed modern `_meta` projection), `MCPDiscoverResult { supportedVersions,
capabilities, resultType: 'complete', ttlMs, cacheScope, instructions?, _meta? }`,
`MCPListResult` (tools + optional modern stamps).

Changed:

- `MCPToolResult` → **`MCPCallResult`** (results named by operation: `MCPCallResult` /
  `MCPListResult` / `MCPDiscoverResult`; avoids the `MCPToolResult`/`MCPToolsResult`
  one-character trap), gains optional `resultType?: 'complete'` and `_meta?`.
- `MCPServerOptions`: `name` + `version` → **`identity: MCPIdentity`**; `description` →
  **`instructions`** (its real consumer is `server/discover`); new
  `cache?: { ttl?: number; scope?: 'public' | 'private' }`.
- `MCPServerInterface`: `name`/`version` → `identity`; `request` event tuple gains
  `era: MCPEra` as third element.
- `MCPClientOptions`: `name` + `version` → `identity?: MCPIdentity`;
  new `capabilities?: Readonly<Record<string, unknown>>` (REQUIRED in modern `_meta`);
  new `version?: MCPVersion` (pin; absent ⇒ negotiate).
- `MCPClientInterface`: new `readonly version: MCPVersion | undefined` (the negotiated
  revision) and `discover(): Promise<MCPDiscoverResult>`.
- `ClientTransportInterface.send`: **batch arm deleted — already shipped**, not adoption work
  (`src/core/types.ts:312` is `send(message: JSONRPCMessage)`; `createDuplexClientTransport`
  has no array fan-out, `src/core/factories.ts:121-139`). Recorded here because the reasoning
  still holds: 2026-07-28 forbids batching and the deletion enforces the MUST in the types.
- No `MCPCapabilities` type: capabilities stay `Readonly<Record<string, unknown>>` (open
  wire record; a named type would also force a pluralized type name).

Error contract — **already shipped, not adoption work**: `src/core/errors.ts:18-51` exports
`class MCPError extends Error { readonly code: number; readonly context: unknown }` and
`isMCPError`, carrying JSON-RPC `code` and `data` so the `-32022` retry can read
`data.supported`. It fixed gap §3.5 in 0.0.8. The adoption **extends** it (the modern codes of
§4.4 and the `-32021`/`-32022` paths); it does not create it.

**Dispatch and handler signatures (specified 2026-07-31; the amendment left this gap).**
`MCPServerInterface` today exposes exactly `dispatch(request): Promise<JSONRPCResponse |
undefined>` and `handle(message): Promise<string | undefined>` (`src/core/types.ts:181-205`).
Neither can carry an abort signal (A5) or a held-open result (A4), so both amendment units
depended on a seam that no contract described. The revised shape:

```ts
/** Per-request execution options every dispatched handler receives. */
export interface MCPDispatchOptions {
	/** Aborts when the caller's request ends — a closed HTTP response stream, a stdio cancel. */
	readonly signal?: AbortSignal
}

/**
 * A held-open modern result: each `yield` is a notification (a `JSONRPCRequest` with no
 * `id`, `types.ts:20-27`); the `return` value is the terminating response — for
 * `subscriptions/listen`, the complete result of a graceful close, which carries a required
 * `_meta` naming the subscription id (§5.1.2).
 */
export type MCPStream = AsyncGenerator<JSONRPCRequest, JSONRPCResponse>

/** The string-boundary mirror of `MCPStream` — the same sequence, already serialized. */
export type MCPTextStream = AsyncGenerator<string, string>

/** One modern method, registered on the seam that dispatches it (§5.1.5). */
export type MCPMethodHandler = (
	request: JSONRPCRequest,
	options: MCPDispatchOptions,
) => Promise<JSONRPCResponse | MCPStream | undefined>
```

and on the interfaces:

```ts
dispatch(request: JSONRPCRequest, options?: MCPDispatchOptions): Promise<JSONRPCResponse | MCPStream | undefined>
handle(message: string, options?: MCPDispatchOptions): Promise<string | MCPTextStream | undefined>
```

Four properties make this the shape rather than an arbitrary one:

- **The signal is an options bag, not a positional parameter.** It is a per-request execution
  concern with exactly one leaf today; a bag absorbs the next one without widening the arity
  again. `MCPRequestContext` (the parsed `_meta` projection) keeps its name and its job —
  these are unrelated axes, and naming both "context" would collapse them.
- **Streams live in the return type, not a second method.** §5.1.5 requires one dispatch path
  with no precedence puzzle; a sibling `stream()` would force every transport to ask "is this
  a stream method?" before calling anything. One call, one narrowing point
  (`Symbol.asyncIterator in result`), at the one place that already pumps messages onto a
  transport.
- **The generator's `return` is the response.** Held-open closure is not an out-of-band event
  in 2026-07-28 — it is a result (§1.4.5), so it belongs where a result belongs. Consuming a
  stream and consuming a unary response therefore end the same way.
- **The string boundary mirrors the typed one.** `handle` is documented as the string
  boundary and `dispatch` as the typed core (`types.ts:167-174`); `MCPTextStream` keeps that
  split intact so `bindServer` serializes and `send`s each message with no second parse.

Both parameters are optional at the public call, so every existing caller compiles unchanged
and a transport that cannot stream (or cannot abort) simply never supplies or narrows one.
This supersedes §9.4's ruling **only for the signal** — see §9.4's amendment.

### 4.4 Constants (`src/core/constants.ts` + server face)

```ts
export const MCP_LEGACY_VERSION: MCPVersion = '2025-06-18' // legacy fallback anchor
export const MCP_META_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const MCP_META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
export const MCP_META_CLIENT = 'io.modelcontextprotocol/clientInfo'
export const MCP_META_SERVER = 'io.modelcontextprotocol/serverInfo'
export const MCP_HEADER_MISMATCH = -32020
export const MCP_MISSING_CAPABILITY = -32021
export const MCP_UNSUPPORTED_VERSION = -32022
export const DEFAULT_MCP_CACHE_TTL = 60_000 // ttlMs is REQUIRED ⇒ needs a default
```

`MCP_` (not `JSONRPC_`) prefix on the new codes mirrors the spec's own allocation split.
Cache scope defaults to **`'private'`** — a mechanism library cannot know whether a
`ToolManager` is per-tenant; `'public'` is opt-in.

**Corrected 2026-07-31 (§8.4 answered).** Three schema findings bind this section:

- **`ttlMs` is REQUIRED and `@minimum 0`, and `0` does not mean "do not cache".**
  `CacheableResult.required` is `["cacheScope","resultType","ttlMs"]` and
  `ListToolsResult.required` is `["cacheScope","resultType","tools","ttlMs"]`. A `0` says the
  result SHOULD be considered immediately stale and the client MAY re-fetch each time — a
  staleness hint, not a prohibition. `DEFAULT_MCP_CACHE_TTL = 60_000` therefore stands and
  §9.6 closes: `0` is schema-legal, but it does not carry the "do not cache" meaning the
  alternative was proposed for, so the condition that ruling was held open against is spent.
- **`tools/list` MUST carry both `ttlMs` and `cacheScope`.** The §6 acceptance rule that a
  modern `tools/call` carries `resultType` and NO `ttlMs` is correct and unchanged —
  `CallToolResult extends Result`, not `CacheableResult`. But no unit ledger ever stated the
  `tools/list` obligation, and U1/U2 emit both fields there or the response is schema-invalid.
- **`HeaderMismatchError` declares no `data` member — only `code`.** The contrast is
  deliberate: `UnsupportedProtocolVersionError` in the same schema file _does_ declare
  `data: { supported: string[]; requested: string }`, and the canonical `-32020` example
  carries no `data` at all. Any reading of a `-32020` data shape is wrong; the `-32022` shape
  is confirmed exactly as designed.

`x-mcp-header` has no schema definition of its own — it occurs once, inside the description of
`Tool.inputSchema`, and every constraint on it is prose (non-empty, RFC 9110 token syntax, no
CR/LF, case-insensitively unique, primitive types with `number` excluded, statically reachable
through `properties` chains). That bears on U7 alone, which stays unscheduled.

Server face (`src/server/constants.ts`): `MCP_METHOD_HEADER = 'mcp-method'`,
`MCP_NAME_HEADER = 'mcp-name'`; `MCP_PROTOCOL_VERSION_HEADER` becomes load-bearing. Browser
face gets the same header constants in `src/browser/constants.ts`.

### 4.5 Pure leaves, by kind

| File                           | Symbol                                                                                      | Contract                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/validators.ts`       | `isModernRequest`                                                                           | Total; `true` iff `params._meta` carries the `MCP_META_VERSION` **key** — presence only, never the value's type (§4.1). The discriminator.                                                                                              |
| `src/core/parsers.ts`          | `parseRequestContext`                                                                       | Total coercer → `MCPRequestContext \| undefined`; the modern-scoped validity step. Soundness pair: defined ⇒ `isModernRequest` true; guard-true + undefined parse = exactly the `-32602` case, which now includes a non-string version. |
| `src/core/inferers.ts` (new)   | `inferEra(version)`                                                                         | Revision→era; unsupported ⇒ `undefined`.                                                                                                                                                                                                |
| `src/core/helpers.ts`          | `buildInitializeResult` (rename of `initializeResult`)                                      | Negotiates over the LEGACY subset only — `initialize` asking for `'2026-07-28'` gets the newest legacy version back; the client decides.                                                                                                |
| `src/core/helpers.ts`          | `buildDiscoverResult`, `buildModernResult`, `buildCallResult` (rename of `buildToolResult`) | `buildModernResult` is the ONE stamping site for `resultType` + `_meta` serverInfo + (when ttl supplied) `ttlMs`/`cacheScope`.                                                                                                          |
| `src/core/helpers.ts`          | `buildJSONRPCResult` / `buildJSONRPCError` (renames of `jsonRPCResult` / `jsonRPCError`)    | `{verb}{Noun}` conformance, matching the other builders.                                                                                                                                                                                |
| `src/server/inferers.ts` (new) | `inferStatus(error, era)`                                                                   | The per-era HTTP status map; keeps status semantics out of core.                                                                                                                                                                        |

### 4.6 `MCPServer` — one dispatch, two branches

```text
era = isModernRequest(request) ? 'modern' : 'legacy'   // key presence only (§4.1)
emit('request', method, id ?? null, era)
notification (no id) ⇒ undefined (unchanged)
modern branch:
  parseRequestContext undefined        ⇒ -32602   (incl. a present-but-non-string version)
  version ∉ SUPPORTED                  ⇒ -32022 { supported, requested }
  methods: server/discover, tools/list, tools/call; all else (incl. initialize, ping) ⇒ -32601
  every result through buildModernResult; discover + tools/list carry cache fields, tools/call does not
legacy branch: today's switch, byte-identical responses (no resultType, no cache fields)
```

The modern method set is **extended, not replaced**, by the amendment: §5.1.5 turns the
hard-coded arm list into a registrable seam, and §5.1.2 registers `subscriptions/listen`
through it. The branch structure, the discriminator, and the legacy arm are unchanged; what
does change is the signature the branch dispatches through — every arm becomes an
`MCPMethodHandler` receiving `MCPDispatchOptions` and free to return an `MCPStream` (§4.3).

`-32021` is never emitted (no implemented method requires a client capability — nothing here
elicits, samples, or reads roots); the constant and `MCPError` recognition still ship because
the **client** must understand it from foreign servers. **Amended (§5.1.1):** once a tool can
produce an `ElicitRequest`, a modern request from a client that never declared elicitation,
for an operation that cannot proceed without operator input, becomes exactly the `-32021`
case — the server may only name request types the client declared (§1.4.4), so the honest
answer is `MissingRequiredClientCapability` with `data.requiredCapabilities`, not a fabricated
result. The server side of `-32021` therefore ships with A3. Core dispatch stays stateless for
legacy too: the four legacy methods' shapes do not differ between 2025-06-18 and 2025-11-25
on the tools-only surface, so no per-connection version context parameter is needed (the
analyst's `MCPDispatchContext` is recorded as the fallback mechanism if a future legacy
divergence appears; the HTTP session middleware pins the negotiated version at its own layer).

### 4.7 `MCPClient` — negotiate once, then be boring

- `connect()` keeps its name and its five-line consumer experience (the era is invisible):
  pinned legacy version ⇒ legacy handshake unchanged; otherwise modern-first —
  `server/discover` stamped with modern `_meta`; success ⇒ intersect `supportedVersions`
  with ours, take newest, set `version`, emit `connect`.
- `-32022` ⇒ pick from `error.context.supported`, retry **exactly once** with a new id.
- `-32601`/`-32600` or an HTTP 400 whose body is not a recognized modern error ⇒ fall back
  to `initialize`; the legacy result's `protocolVersion` is now **validated** (unsupported /
  absent / malformed ⇒ close transport + reject — fixes gap §3.2). Pinned `'2026-07-28'` ⇒
  no fallback.
- Era determination caches on the client instance for its lifetime (the spec's per-origin
  cache at the granularity this library owns).
- Every modern request stamps `_meta` (version, capabilities, clientInfo). The modern client
  sends zero notifications, so "clients MUST NOT POST notifications over HTTP" holds by
  construction. `notifications/initialized` is legacy-only.
- **Result-type safety**: absent `resultType` ⇒ complete; `'complete'` ⇒ complete; anything
  else (`'input_required'`, `'task'`, unknown) ⇒ throw `MCPError` naming it. This client
  answers no MRTR request, and silently reading an `input_required` result as tool output
  would hand a model fabricated results. **Unchanged by the amendment:** §5.1.1 adds MRTR
  _production_ on the server side only; our client still produces no `inputResponses`, so
  throwing remains the only honest reading of an unanswered request.

### 4.8 Transport faces

- **Node HTTP ingress** (`handlers.ts`, new `inferers.ts`, `middlewares.ts`):
  - Modern POST: `MCP-Protocol-Version` REQUIRED and MUST equal body `_meta` version;
    `Mcp-Method` REQUIRED = body method; `Mcp-Name` REQUIRED **only** on the three methods
    §1.4.6 names — `tools/call` (= `params.name`), `resources/read` and `prompts/get`
    (= `params.uri`/`params.name`), of which this package implements only `tools/call`.
    Ingress therefore requires `Mcp-Name` on `tools/call` and MUST NOT require it on
    `server/discover` or `tools/list`, which carry no name or URI to derive it from.
    Violation ⇒ 400 + `-32020`.
  - Status map (modern only): 202 notification; 400 for `-32020`/`-32021`/`-32022`/`-32602`;
    404 for `-32601`; 200 otherwise. Legacy requests keep today's uniform 200 in-band errors
    — nothing regresses.
  - Headerless POST ⇒ **no version is inferred** (§4.2, corrected), and the three cases §8.12
    settled are the whole rule: `initialize` is legitimately headerless and is accepted; a
    post-`initialize` legacy request on a live session is accepted and answered under the
    version that session negotiated; **every other headerless request is rejected with 400 +
    `-32020`**, because nothing identifies its era and we are, in the spec's words, a server
    that does not support pre-2025-06-18 clients.
  - Origin gate: same-origin/no-origin allowed by default; cross-origin requires explicit
    `origins` allowlist option; invalid ⇒ 403. Mechanism only — which origins is consumer
    policy. (Planner dissented; §9.2.)
  - SSE responses gain `X-Accel-Buffering: no`.
  - **`createMCPSession` passes modern-shaped POSTs straight through via `next()`, ignoring
    `Mcp-Session-Id`** (fixes gap §3.4); it stays the legacy session layer otherwise and pins
    each session's negotiated legacy version.
- **Both HTTP client transports** (Node + browser) stamp **modern** POSTs with
  `MCP-Protocol-Version` and `Mcp-Method` — always, on every modern request — and with
  `Mcp-Name` **only where the method carries one** (`tools/call`; `resources/read` and
  `prompts/get` are excluded surfaces, §5). `server/discover` and `tools/list` carry two
  headers, not three: §1.4.6 scopes `Mcp-Name` to named methods, and there is nothing in
  either body to derive it from. Legacy POSTs keep `MCP-Protocol-Version` alone — `Mcp-Method`
  and `Mcp-Name` are 2026-07-28 additions and must not be stamped on a handshake-era request.
  Every value is derivable from the message the transport already holds, so `send(message)`
  still needs no widening.
- **WebSocket, stdio, MessagePort**: no changes — no headers; era rides in `_meta`.
  `serveMCP` inherits dual-era for free because it composes the core server.

### 4.9 Rejected alternatives (on the record)

- **Two server classes (legacy + modern)**: a dual-era endpoint would need both mounted
  behind one route with hand-rolled discrimination; duplicates registry binding and breaks
  one-concept-one-term.
- **Construction-time `era` option**: is precisely the cross-request inference the
  statelessness doctrine forbids, hoisted a level; unknowable for a public endpoint;
  a stored label that can disagree with the request in hand.
- **`MCPDispatchContext` on `dispatch`/`handle`** (analyst): rejected **as a version carrier**
  — legacy responses are revision-invariant on the tools-only surface, and that half of the
  ruling stands. The _second parameter itself_ is no longer avoidable: A5 must deliver an
  abort signal to a running handler, so §4.3 adds `MCPDispatchOptions`. The analyst was right
  about the arity and wrong about the payload; recorded as such in §9.4.
- **Widening `send(message, context?)`** (analyst): needed only by `Mcp-Param-*` projection;
  see §8.2 before ever adopting.

---

## 5. Scope matrix (reconciled)

"Implement" = shipped and tested in the adoption campaign. "Exclude" = intentionally absent
AND named in the guide's new **Declared non-goals** subsection — never silently dropped.
**"Declared conformance gap"** is a third, harsher ruling added on 2026-07-31: a spec MUST
this package does not satisfy. It is not a non-goal, because a non-goal is a capability we
chose not to build, and a MUST is not ours to decline. It gets its own guide subsection naming
the clause, the consequence for a consumer, and the unit that would close it.

Rows marked **amended** were ruled on 2026-07-28 with "no consumer exists" as their stated
reason, and re-ruled on 2026-07-31 once `@orkestrel/supervisor` became that consumer. §5.1
carries each flip in full: old ruling, new ruling, reason, and the consumer that expired the
old reason. A row without an **amended** mark is unchanged.

| Feature                                                                             | Ruling                                                                 | Reason                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-request `_meta` (version/capabilities REQUIRED; clientInfo/serverInfo SHOULD)   | Implement                                                              | Mandatory; the discriminator itself.                                                                                                                                                                                                                                                                                                    |
| `_meta.progressToken`                                                               | Implement as passthrough                                               | Must not be misread as a modern marker; we neither generate nor consume progress.                                                                                                                                                                                                                                                       |
| `_meta.logLevel`                                                                    | Exclude                                                                | Belongs to logging, deprecated in 2026-07-28. No consumer opts a request into server log emission.                                                                                                                                                                                                                                      |
| `_meta.subscriptionId`                                                              | **Implement — amended (§5.1)**                                         | Flips with `subscriptions/listen`: it is the stream's correlation key, so excluding it would leave every stream notification uncorrelatable. Consumer: `@orkestrel/supervisor`'s observation stream.                                                                                                                                    |
| W3C `traceparent`/`tracestate`/`baggage`                                            | Exclude                                                                | Tracing is application policy; the `request` event is the observation seam; consumers stamp their own.                                                                                                                                                                                                                                  |
| `server/discover`                                                                   | Implement                                                              | Mandatory server RPC; surfaced as `client.discover()` (instructions otherwise unreachable).                                                                                                                                                                                                                                             |
| Method seam for revisions/extensions beyond the built-in set                        | **Implement — amended (§5.1)**                                         | §4.6's modern branch answers three hard-coded methods and `-32601` for everything else, so `subscriptions/listen` and every Tasks method would each need another `switch` arm in core. Consumer: `@orkestrel/supervisor` needs the first and may want the rest.                                                                         |
| `resultType` on every modern result                                                 | Implement                                                              | Mandatory; one stamping site; client treats absent as complete.                                                                                                                                                                                                                                                                         |
| MRTR production (`inputRequests`/`requestState`)                                    | **Implement, `ElicitRequest` only — amended (§5.1)**                   | Consumer: `@orkestrel/supervisor`'s `reply` path needs operator input in band. Sampling and roots stay excluded (deprecated, no consumer). `requestState` is an opaque **string**, attacker-controlled from the server's view ⇒ MUST be integrity-protected (§5.1.1, corrected).                                                        |
| `subscriptions/listen`                                                              | **Implement, modern-only — amended (§5.1)**                            | The producer that did not exist now does: `@orkestrel/supervisor`'s normalized observation stream. A held-open result gets its own return arm (`MCPStream`, §4.3) rather than being forced through one-request→one-response dispatch. MCP defines no subscription key, so supersession is not a mechanism to build (§5.1.2, corrected). |
| `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` headers                            | Implement (both HTTP faces + ingress validation)                       | REQUIRED; derivable from the in-hand message; closes gap §3.1. `Mcp-Name` is scoped to the named methods §1.4.6 lists — on our surface, `tools/call` alone (§4.8, corrected).                                                                                                                                                           |
| `Mcp-Param-*` + `x-mcp-header` client-side projection                               | **Declared conformance gap — not a non-goal** (§5.1.9; §8.2 may close) | §1.4.6 records a client-side MUST, so calling this an exclusion misstated it (pre-existing). We do not satisfy it: the projection needs the tool schema (client-only knowledge) inside the HTTP transport, an HTTP-shaped widening of the transport-agnostic port. U7 remains the isolated unit that would close it.                    |
| `x-mcp-header` server-side annotation + invalid-definition filtering                | Exclude — vacuously satisfied                                          | The MUST to keep invalid annotated definitions out of `tools/list` binds a server that accepts the annotation. Installed `@orkestrel/tool` definitions carry no `x-mcp-header`, so none exists to be invalid. If A7 or a later contract admits the annotation, the filter ships with it.                                                |
| HTTP status mapping (202/400/403/404/405)                                           | Implement (modern-scoped)                                              | Legacy keeps today's uniform 200 in-band errors; modern gets the exact codes. 405 GET/DELETE is already true of a session-free mount — documented, not coded.                                                                                                                                                                           |
| Modern HTTP disconnect-cancellation                                                 | **Implement — amended (§5.1)**                                         | 2026-07-28 removes client→server notifications over HTTP: closing the response stream IS the cancellation signal (`notifications/cancelled` survives on stdio only). Today `request.signal` only detaches an SSE session (`middlewares.ts:114-115`).                                                                                    |
| `X-Accel-Buffering: no` + SSE comment keep-alives                                   | Implement                                                              | SHOULD; trivial; comment-flush idiom already exists.                                                                                                                                                                                                                                                                                    |
| `-32020`                                                                            | Implement (HTTP face emits)                                            |                                                                                                                                                                                                                                                                                                                                         |
| `-32021`                                                                            | **Implement both directions — amended (§5.1.1)**                       | Was constant + client recognition only, because no implemented method required a client capability. `ElicitRequest` production creates one: a client that never declared elicitation, on an operation that needs it, gets `data.requiredCapabilities`.                                                                                  |
| `-32022` + data                                                                     | Implement both directions                                              | Server emits `{ supported, requested }`; client retries once with new id.                                                                                                                                                                                                                                                               |
| Retired `-32002`/`-32042` MUST NOT emit                                             | Already true; add policy assertion                                     | Neither is emitted today.                                                                                                                                                                                                                                                                                                               |
| `CacheableResult` on `tools/list` + `server/discover`                               | Implement                                                              | The only two cacheable results this package produces. `cache` option; default scope `'private'`.                                                                                                                                                                                                                                        |
| Deterministic `tools/list` order                                                    | Contract + parity assertion, no code                                   | Registry insertion order is already deterministic and is the caller's intent.                                                                                                                                                                                                                                                           |
| `extensions` capability field                                                       | Exclude from the first slice (**amended scope**, §5.1)                 | Capabilities stay an open record, so a consumer can already declare an extension id without a library change. Reading the map becomes load-bearing only if A7 lands; nothing else may depend on it.                                                                                                                                     |
| Tasks extension (`io.modelcontextprotocol/tasks`)                                   | **Optional augmentation, never the substrate — amended (§5.1)**        | The durable handle is a durable id in an ordinary `tools/call` result, on every era, with no negotiation. `tasks/get`/`tasks/update`/`tasks/cancel` MAY be added later (A7); core `tasks/list` and blocking `tasks/result` are gone in 2026-07-28.                                                                                      |
| Durable task storage                                                                | **Injected contract, only with A7 — amended (§5.1)**                   | Task state outlives a request by definition, and this package owns no persistence. It would arrive injected, exactly as `ToolManagerInterface` does. Absent A7 there is no store and no storage dependency.                                                                                                                             |
| Resources / Prompts / Roots / Sampling / Logging                                    | Exclude                                                                | No registries/consumers; roots/sampling/logging deprecated in 2026-07-28. Local emitters remain observability, not an MCP logging capability. `@orkestrel/supervisor` explicitly takes **no resources in its first slice** — `inspect` carries the read.                                                                                |
| Elicitation                                                                         | Split (**amended**, §5.1)                                              | The legacy server-initiated `elicitation/create` request stays excluded (no consumer, and 2026-07-28 removes server-initiated requests entirely). Modern `ElicitRequest` production inside an MRTR result is implemented — see the MRTR row.                                                                                            |
| Icons (2025-11-25)                                                                  | Exclude                                                                | Installed `@orkestrel/tool` tool definitions carry no icon field; an MCP-only wrapper has no originating consumer.                                                                                                                                                                                                                      |
| Protocol-native `tools/call` results (`structuredContent`)                          | **Implement — amended (§5.1)**                                         | `buildToolResult` collapses every value into one `JSON.stringify` text block (`helpers.ts:95-103`), so a durable handle reaches the client as a string a model must re-parse. Consumer: `@orkestrel/supervisor` returns a durable id from every command.                                                                                |
| `outputSchema` on tool descriptors                                                  | Exclude (unchanged)                                                    | The installed `ToolResult` (`@orkestrel/tool`) is a success-discriminated union whose `value` stays `unknown`; the schema half belongs first to the tool contract that owns it. §8.8 answered: no clause gates `structuredContent` on a declared `outputSchema`, so the exclusion holds without cost (§5.1.4).                          |
| SSE polling / resumability                                                          | Legacy-only (existing session middleware), unchanged                   | Modern requests must not use it; the broader optional 2025-11 polling protocol has no consumer.                                                                                                                                                                                                                                         |
| Hostile-input limits + protocol-faithful fixtures                                   | **Implement — amended (§5.1)**                                         | `handle()` `JSON.parse`s an unbounded string and nothing caps `_meta` size, `requestState` size, or live subscriptions. A public, long-lived service host makes each of those a denial-of-service surface rather than a theoretical one.                                                                                                |
| Origin → 403                                                                        | Implement minimal gate (`origins` option, secure default)              | Spec MUST on the server component this package ships; policy (the list) stays with the consumer. Planner dissent §9.2.                                                                                                                                                                                                                  |
| Tool-invocation rate limiting (2025-11-25 `server/tools` § Security Considerations) | **Declared conformance gap — not a non-goal** (§5.1.10)                | Surfaced by §8.5. The clause is a server MUST and we do not satisfy it: a rate limit is a decision about one caller's traffic against one deployment's capacity, which mechanism-not-policy puts with the consumer. No unit closes it inside this package; the guide names the clause and the consumer's obligation.                    |
| Batching removal                                                                    | Implement by deletion                                                  | Batch arm removed from `send`; 2025-03-26 dropped; MUST enforced in types.                                                                                                                                                                                                                                                              |
| `initialize`/`ping`/sessions/GET-stream                                             | Legacy-only (dual-era)                                                 | Present in legacy; `-32601`/405 in modern.                                                                                                                                                                                                                                                                                              |

### 5.1 Amendments, 2026-07-31 — the flipped exclusions and the gaps they exposed

Four of the rows above were excluded with the same shape of reason: _the mechanism is real,
the spec is understood, and nothing in the fleet would call it._ That reason was true and is
now expired. **`@orkestrel/supervisor`** — one package (core + server) that runs workflows
durably, detached from the client that started them, with a human in the loop — is the
consumer. A fifth row (structured tool output) was declined for a different reason, and only
half of it flips. Three more gaps surfaced that no row had named at all. Each entry below
gives the old ruling, the new one, the reason, and what consumes it. Entries 9 and 10 are the
exceptions: neither changes a decision and neither has a consumer, because each relabels an
obligation that was never ours to decline — 9 pre-existing, 10 surfaced by the 2026-07-31
evidence pass.

Two properties of that consumer do the work, and both come from its binding verdict rather
than from any preference of this document. First, **the client disconnects on purpose**: a
`tools/call` returns a durable id promptly and the run continues in a service host that
outlives the caller. Second, **the run asks for things later**: an operator approval or an
input request can arrive minutes after the call that started the work already returned.

1. **MRTR production — Exclude ⇒ Implement, `ElicitRequest` only.**
   The old reason ("needs elicitation/sampling/roots — none exist") was accurate: MRTR is a
   carrier, and we had nothing to carry. The supervisor's `reply` command is cargo. A
   `supervisor` call that cannot proceed without operator input returns
   `resultType: 'input_required'` with one `ElicitRequest`, and the client retries the
   original request under a new id carrying `inputResponses` plus the byte-exact
   `requestState`. **Sampling and roots stay excluded** — both deprecated in 2026-07-28, and
   neither has a consumer; a server that advertises only `ElicitRequest` never has to reason
   about a client that declared the other two.
   **This is what finally makes `-32021` emittable.** A server may name only the request types
   the client declared (§1.4.4). A client that never declared elicitation, calling an operation
   that cannot proceed without operator input, is precisely
   `MissingRequiredClientCapability` — so the server side of `-32021` ships with A3 and §4.6's
   "never emitted" note is amended there. The alternative would be inventing an answer the
   operator never gave, which is the one thing this whole flip exists to prevent.
   **This is production only, and only for the call in hand.** Per the verdict, MRTR is
   structurally incapable of pushing a _later_ input request into an already-completed call,
   so it covers exactly the in-band case; the detached case belongs to flip 2. §4.7's
   client-side rule is unchanged: our `MCPClient` still throws a named `MCPError` on any
   non-`'complete'` `resultType` from a foreign server, because it produces no
   `inputResponses` and must never read an unanswered request as tool output.
   **`requestState` MUST be integrity-protected.** The spec is explicit that it is opaque and
   attacker-controlled from the server's view; the supervisor's echoed state names a run and a
   pending decision, so an unverified echo is an authorization forgery. The mechanism already
   exists and is already a declared peer dependency: `@orkestrel/server`'s `signToken` /
   `verifyToken` mint and verify a stateless HMAC token (`crypto.subtle.sign('HMAC', …)`, an
   HMAC-covered `ttl`, and a `[current, ...older]` rotation list). **No new code and no new
   dependency.** MCP ships the round-trip and the guide's MUST; the secret, the TTL, and the
   decision to sign are consumer policy.
   **Wire shape corrected 2026-07-31 (§8.9 answered).** Three of this entry's shapes were
   wrong and a fourth constraint was missing:
   - **`inputRequests` is a map, not an array** — `InputRequests { [key: string]:
InputRequest }`, keys server-assigned and unique per request. Every sentence in this
     document that read it as a list is corrected here.
   - **`requestState` is an optional `string`, not bytes** — "opaque **string**, echoed
     byte-exact". Servers MUST treat it as attacker-controlled and MUST integrity-protect it
     wherever it influences authorization, resource access, or business logic, and replay
     defence SHOULD bind principal, TTL, and an originating-request identifier _inside_ the
     protected payload. That last clause is the actual cargo the `signToken`/`verifyToken`
     round-trip has to carry; signing an opaque blob without those three fields satisfies the
     letter and not the clause.
   - **The echo is top-level in `params`** — `CallToolRequestParams extends
InputResponseRequestParams`, so `params.inputResponses` and `params.requestState` are
     siblings of `name` and `arguments`, never nested inside `arguments`.
   - **`InputRequiredResult` is permitted only on `prompts/get`, `resources/read`, and
     `tools/call`**, and a server MUST include at least one of `inputRequests` or
     `requestState` in every one it sends. The retry-under-a-new-id rule above is confirmed.
     `-32021`'s data shape is confirmed exactly as proposed: `{ requiredCapabilities:
ClientCapabilities }`, HTTP 400.

   **The elicitation-mode constraint this entry lacked.** `elicitation` is declared as
   `{ form?, url? }`, and an **empty capabilities object means form mode only**; a server
   **MUST NOT** send a mode the client did not declare. `ElicitRequestParams` is itself a union
   — form (`mode?: 'form'`) versus URL (`mode: 'url'`). A3 therefore produces form-mode
   elicitation and checks the declared mode before sending, rather than assuming that any
   declared `elicitation` capability accepts anything. Two related facts, both recorded as
   found: `CreateMessageRequest` and `ListRootsRequest` are deprecated in 2026-07-28 but remain
   legal members of the union (the spec's own example mixes elicitation with sampling), so
   producing `ElicitRequest` only is a _production_ choice of ours and not a shape constraint;
   and whether an elicitation-only server owes anything to a client that declared sampling or
   roots is **not stated** — no clause imposes a duty toward a capability we never advertise.

2. **`subscriptions/listen` and `_meta.subscriptionId` — Exclude ⇒ Implement, modern-only.**
   The old reason was the honest absence of a producer: `ToolManager` is event-free, so a
   held-open stream would have had nothing to say. The supervisor's normalized observation
   stream is the producer, and it is also the only path by which a detached run can surface
   `input_required` after its launching call returned. The stream carries the spec's shape
   verbatim: `notifications/subscriptions/acknowledged` first, every notification stamped with
   `_meta['io.modelcontextprotocol/subscriptionId']`, and a graceful close carrying that same
   stamp (corrected below).
   **Where the one-subscription-per-epoch invariant lives.** MCP supplies the stream and the
   correlation id; the _meaning_ of a subscription is the consumer's:
   `@orkestrel/supervisor` binds it to its epoch, which is what makes "one subscription per
   epoch" true without MCP ever learning the word "epoch". Mechanism here, policy there.
   **The supersession rule is WITHDRAWN, not deferred (§8.10 answered).** "At most one live
   stream per key, and a superseding listen gracefully closes the stream it replaces" was this
   document's preferred reading and was held back from A4's criteria pending evidence. The
   evidence returned **not stated**, for a reason that dissolves the question rather than
   leaving it open: **MCP has no concept of a subscription key at all.** A subscription's
   identity is the JSON-RPC request id of its `subscriptions/listen` request and nothing else
   (`RequestId = string | number`); the only multiplicity text in the specification is that a
   client MAY have multiple active subscriptions concurrently, demultiplexed by that id. There
   is no uniqueness rule, no supersession permission, and no rejection error code — the
   reserved range holds only `-32020`, `-32021`, and `-32022`. The provisional rule presumed a
   mechanism the protocol does not have, so there is nothing for a later task to confirm and
   nothing to defer. It is withdrawn, and A4's criteria (§6.2) drop the criterion outright
   rather than carrying it as pending.
   This **strengthens** the mechanism/policy split ruled two paragraphs above rather than
   weakening it. MCP supplies no supersession mechanism; building one would be inventing
   protocol, which is the one thing a conformance-first library must not do. The
   one-subscription-per-epoch invariant therefore belongs entirely to `@orkestrel/supervisor`,
   which already owns epoch identity and enforces the invariant by simply declining to open a
   second listen. Mechanism here, policy there — and in this case the mechanism is the absence
   of one.
   **Graceful closure is not an empty complete result (corrects §1.4.5 and this entry).**
   `SubscriptionsListenResult._meta` is **required**, and
   `_meta['io.modelcontextprotocol/subscriptionId']` is a required key inside it — corroborated
   by `schema.json`'s `"required": ["_meta", "resultType"]`. The closing frame carries
   `resultType` plus that `_meta`, so a test asserting an empty result would assert the wrong
   shape. Server-initiated closure is a SHOULD, not a MUST. The acknowledgement is
   `notifications/subscriptions/acknowledged` carrying `params.notifications` — the
   `SubscriptionFilter` subset the server actually honours — and it MUST be the first message
   **carrying the subscription id**. Ordering is defined per subscription id, not per channel,
   so on stdio another subscription's messages MAY interleave ahead of it; asserting "first
   message on the wire" would assert more than the spec says.
   **Modern-only, stated as a limit.** `subscriptions/listen` is a 2026-07-28 method, and the
   supervisor targets modern first. A legacy-era client still gets `start`, `inspect`, and
   `reply`; its observation path remains the existing session stream's
   `notifications/message`, which is a strictly weaker unsubscribed channel. Under both eras
   `inspect` is authoritative and notifications are hints — so nothing degrades into polling.

3. **Tasks extension — Exclude ⇒ optional augmentation, never the substrate.**
   The substrate is settled and is not Tasks: **a durable id in an ordinary `tools/call`
   result**, on every era, with no capability negotiation. Everything the supervisor promises
   — handle, reconnect, control, result — must work for a client that has never heard of the
   extension. Two facts hold the ruling: the extension has no implementations to interoperate
   with, and 2026-07-28 removed the blocking `tasks/result` that made a task id useful as a
   _result_ channel (core `tasks/list` is gone too; `ttl`/`pollInterval` became
   `ttlMs`/`pollIntervalMs`). What remains is genuinely useful as decoration — `tasks/get`,
   `tasks/update`, `tasks/cancel`, and an unsolicited `CreateTaskResult`
   (`resultType: 'task'`) — so A7 may add it when a client that actually negotiates the
   extension exists.
   **Nothing may depend on Tasks being negotiated.** No command may require it, no result may
   substitute a task id for the durable id, and no test may reach green only on the Tasks
   path. If A7 is never scheduled, the supervisor loses no capability. That is the test of
   this ruling, and it is the reason `extensions` stays out of the first slice.
   **A7's trigger has fired, and A7 is re-ruled rather than quietly ignored (§8.11
   answered).** The trigger written above — "a client that actually negotiates the extension
   exists" — is satisfied: **MCP Inspector 2.0.0 advertises `io.modelcontextprotocol/tasks` by
   default** (`defaultAdvertised: true`), published to npm as `latest` and confirmed in the
   published bundle. Recording that and then acting as though it had not happened would be the
   dishonest reading, so the orchestrator re-rules here. **A7 stays unscheduled on a corrected
   trigger: a consumer that _needs_ it, not a client that _advertises_ it.** Three facts carry
   the re-ruling. The extension's schema is still `draft`. Neither official SDK implements it —
   the Python SDK says so in writing and the TypeScript SDK answers inbound `tasks/*` with
   `-32601` — and Goose has zero occurrences of the id. And the sole negotiator is the
   protocol's own inspector advertising by default, which demonstrates that the wire works, not
   that anyone wants it. Advertisement is supply; a scheduling trigger has to be demand.
   The re-ruling costs nothing, which is why it is available: the durable id in an ordinary
   result is already the substrate, so every supervisor capability holds with Tasks
   un-negotiated. The wire shapes are now verified and recorded for whenever A7 _is_ scheduled:
   `CreateTaskResult = Result & Task`; `Task { taskId, status, statusMessage?, createdAt,
lastUpdatedAt, ttlMs: number | null, pollIntervalMs? }`; `TaskStatus = 'working' |
'input_required' | 'completed' | 'failed' | 'cancelled'`; `tasks/get` → `Result &
DetailedTask`; `tasks/update { taskId, inputResponses }`; `tasks/cancel { taskId }`;
   `resultType: 'task'` MUST be set on `CreateTaskResult` and MUST NOT appear on anything else;
   only `tools/call` is task-eligible today. The removals this entry already assumed are
   confirmed: core `tasks/list` and blocking `tasks/result` are both gone, and calling
   `tasks/result` MUST yield `-32601`.

4. **Protocol-native `tools/call` results — Exclude for now ⇒ Implement `structuredContent`.**
   `buildToolResult` puts every value through `JSON.stringify` into a single text block
   (`src/core/helpers.ts:95-103`). For a tool returning prose that is exactly right. For a
   supervisor returning `{ id, revision, status }` it means the one field the whole design
   turns on — the durable handle — reaches the client as characters inside a string, to be
   found again by parsing. A durable handle that a model has to re-parse out of a text blob is
   a handle with a failure mode. Results carry `structuredContent` alongside the text block.
   The schema half (`outputSchema` on descriptors) does **not** flip: `ToolResult.value` is
   `unknown` in the installed `@orkestrel/tool`, and the contract that owns the value owns its
   schema.
   **Verified 2026-07-31 (§8.8 answered); the flip proceeds unchanged.** The serialized-JSON
   text block is a **SHOULD**, framed as backwards compatibility, so carrying both is
   conformant. `structuredContent?: unknown` sits on `CallToolResult` and `outputSchema?` on
   `Tool`, and every `outputSchema` obligation is conditional on one being defined; no clause
   gates `structuredContent` on a declared `outputSchema`. That permission is **inferred from
   the absence of a gating clause** — no source states it affirmatively — which is enough to
   proceed, because the schema marks the field optional and unconditioned and A2 ships nothing
   that needs the stronger reading. `content` is required and `resultType` is
   inherited-required from `Result`. **One new fact A2 must honour:**
   `CallToolResultResponse.result` is the union `CallToolResult | InputRequiredResult`, so the
   response slot A2 writes into is the one A3 also writes into; A2 must not narrow that union
   out from under A3.

5. **A method seam — newly surfaced.** §4.6's modern branch answers `server/discover`,
   `tools/list`, and `tools/call`, and returns `-32601` for everything else. That was right
   for a package whose whole surface was those three. Flip 2 adds a method now, flip 3 may add
   three more, and the next revision will add its own, so the choice is a `switch` in core
   that grows with every revision or one seam. The seam: a registrable method handler, with
   the built-in methods registered through
   the same mechanism they are dispatched by — no second dispatch path, no precedence puzzle,
   and an unregistered method still `-32601`. This **extends** §4.6's method set; it does not
   contradict the branch structure, the discriminator, or the era rules.
   **The handler's type is `MCPMethodHandler` (§4.3)** — `(request, options) => Promise<
JSONRPCResponse | MCPStream | undefined>`. That signature is what makes flips 2 and 6
   implementable at all: without the `MCPStream` arm a held-open method has no way to answer,
   and without `MCPDispatchOptions` a running handler never learns its caller left. The
   amendment named both requirements and specified neither; §4.3 now does.

6. **Modern HTTP disconnect-cancellation — newly surfaced.** 2026-07-28 removes client→server
   notifications over HTTP: closing the response stream _is_ the cancellation signal, and
   `notifications/cancelled` survives on stdio only. Today `request.signal` reaches exactly one
   place — detaching an SSE session stream (`src/server/middlewares.ts:114-115`) — and no
   signal reaches a running `tools/call`. For a bounded tool that is harmless. For a
   supervisor holding a subscription stream and an external process it is the difference
   between a disconnect and a leak. The signal is plumbed to the handler **through
   `MCPDispatchOptions.signal` (§4.3)** — the contract the amendment assumed and did not
   write; what a handler does with it stays the consumer's (the verdict is emphatic that
   requested cancellation is not observed termination).

7. **Hostile-input limits and protocol-faithful fixtures — newly surfaced.** `handle()`
   `JSON.parse`s an unbounded string, and nothing bounds `_meta` size or key count,
   `requestState` size, content size, or the number of live subscriptions. A library embedded
   in a caller's process could defer that; an independent, long-lived service host — which the
   verdict says the supervisor requires, because a client-spawned stdio process cannot
   honestly promise to outlive its client — cannot. Limits are configurable with secure
   defaults and are exercised by fixture peers that speak the wire, per the repository's
   no-mocks law and the established `tests/fixtures/browserServer.ts` pattern.

8. **Durable task storage — conditional on A7.** If Tasks is ever adopted, task state outlives
   the request that created it, and this package owns no persistence and must not acquire any.
   A store arrives as an injected contract, exactly as `ToolManagerInterface` does today.
   Absent A7 there is no store, no storage dependency, and no dormant interface.

9. **`Mcp-Param-*` — Exclude ⇒ declared conformance gap (corrects pre-existing text).** Not a
   flip: the decision is unchanged and U7 is still unscheduled. What changes is the honesty of
   the label. §1.4.6 records that HTTP clients **MUST support** the `x-mcp-header` projection;
   §5 called it an exclusion and §8.2 deferred the decision, which together read as though
   declining were ours to decline. It is not. An unbuilt MUST is a gap in conformance, and the
   guide says so in its own subsection rather than burying it among capabilities we chose not
   to build.
   **What it actually costs a consumer**, stated plainly: against a foreign 2026-07-28 server
   whose tool schemas annotate `x-mcp-header`, our HTTP client transports send those params in
   the body only. If such servers accept body params — the reading §8.2 tests — nothing breaks
   and the gap is cosmetic; if any of them require the header projection, those tools are
   uncallable through this client until U7 lands. That is the whole exposure, and it is
   bounded to foreign modern servers using an optional annotation.
   **The server half is a separate row and is vacuously satisfied**: the MUST to exclude
   invalid annotated tool definitions from `tools/list` binds a server that accepts the
   annotation, and installed `@orkestrel/tool` definitions carry no `x-mcp-header` field, so
   there is no definition that could be invalid. Nothing is hidden from a caller, which was
   the planner's original objection (§9.3) to implementing the filter half alone.

10. **Tool-invocation rate limiting — declared conformance gap (surfaced 2026-07-31).** Not a
    flip and not a decision: §8.5's measurement of the 2025-11-25 mandatory surface turned up a
    MUST no row had ever named. `server/tools` § Security Considerations binds a server to
    validate all tool inputs, implement proper access controls, **rate limit tool
    invocations**, and sanitize tool outputs. Three of those four are already true of this
    package or belong to the tool contract that owns the values. The rate limit is neither, and
    will not become either: a limit is a judgement about how much traffic a particular caller
    may spend against a particular deployment's capacity, and mechanism-not-policy puts both
    numbers with the consumer. A framework that picked one would be picking product policy, and
    a framework that picked an unlimited one would be pretending to satisfy the clause.
    **So it is recorded as an unmet MUST rather than declined as a non-goal**, exactly as entry
    9 records `Mcp-Param-*`. The difference between the two is worth stating: `Mcp-Param-*` is
    closable inside this package and has a named closer (U7); this one is not, and its closer
    is the deployment. U6's Declared conformance gaps section names the clause, says plainly
    that a consumer exposing this server publicly must impose its own invocation limit at the
    layer fronting it, and does not imply that a future unit will absorb the obligation.
    **It does not reopen §4.2.** §9.1's ruling to support 2025-11-25 survives with the gap
    declared — a declared gap is the honest form of an unmet MUST, and dropping the revision
    would not make this library rate-limit anything.

---

## 6. Unit decomposition and routing ledger

Strictly serialized writers, each from a clean committed baseline. Every unit owns its
mirrored `tests/src/**` files. Engines per the operating contract: Sol = objective
implementation (via `codex` role, journaled exec); Opus = subjective/documentation-voice;
Sonnet `builder` = fully specified mechanical; `verifier` = gates.

**Guide ownership, corrected 2026-07-31 (orchestrator sequencing ruling).** The ledger made
`guides/src/mcp.md` off-limits to every unit but U6. Taken literally that leaves guide parity
red from U0 until U6 — twelve units during which every rename and every new export is drift the
parity test is entitled to fail on, and a gate nobody may legitimately ignore is a gate that
teaches people to ignore it. **Each unit therefore updates the guide's mechanical symbol
references for the symbols it changes, so parity stays green across the whole campaign, and U6
keeps sole ownership of structure, voice, and the new sections** (Declared non-goals, Declared
conformance gaps, the Contract clauses). The split is mechanical-versus-editorial, not
file-versus-file: renaming `MCPToolResult` to `MCPCallResult` in a table cell is the rename
itself finishing its job; deciding what the guide _says_ about results remains U6's. U0 has
already shipped under this rule.

| Unit | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Owned files                                                                                                          | Engine                 | Depends on              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------- |
| U0   | Rename sweep, zero behavior change: `MCPToolResult`→`MCPCallResult`, `buildToolResult`→`buildCallResult`, `initializeResult`→`buildInitializeResult`, `jsonRPCResult`/`jsonRPCError`→`buildJSONRPCResult`/`buildJSONRPCError`, `MCPServerInfo`→deleted, `name`+`version`→`identity` (both options bags + server interface), `description`→`instructions`. **The batch-arm deletion is NOT in this unit — it shipped in 0.0.8** (`types.ts:312`, `factories.ts:121-139`)                                                                                                                                                                                                                                                          | core/server/browser sources + all touched tests                                                                      | `builder` (Sonnet)     | —                       |
| U1   | Modern contract + pure leaves: §4.3 types (incl. `MCPDispatchOptions`/`MCPStream`/`MCPTextStream`/`MCPMethodHandler`), §4.4 constants, **extensions to the shipped `errors.ts`** (`MCPError`/`isMCPError` already exist, `errors.ts:18-51`), `isModernRequest` (key presence), `parseRequestContext` (soundness both directions), `inferEra`, `buildDiscoverResult`, `buildModernResult`                                                                                                                                                                                                                                                                                                                                         | `src/core/{types,constants,validators,parsers,inferers,errors,helpers,index}.ts` + tests                             | `implementer` (Sol)    | U0                      |
| U2   | Dual-era server dispatch (§4.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `src/core/MCPServer.ts` + test                                                                                       | `implementer` (Sol)    | U1                      |
| U3   | Dual-era client (§4.7): discover-first connect, legacy fallback with validated initialize result, `version` getter, `discover()`, `MCPError` surfacing, one-retry `-32022`, result-type safety                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `src/core/MCPClient.ts` + test                                                                                       | `implementer` (Sol)    | U1 (serialize after U2) |
| U4   | Node HTTP conformance (§4.8): header validation, status map, Origin gate, session passthrough for modern POSTs, session version pinning, client-transport headers, `X-Accel-Buffering`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `src/server/{handlers,helpers,inferers,constants,types,middlewares}.ts`, `transports/HTTPClientTransport.ts` + tests | `implementer` (Sol)    | U2, U3                  |
| U5   | Browser face parity: the same header rule on the fetch transport (version + method always on modern; name only on `tools/call`); environment isolation proven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `src/browser/{types,constants,helpers,factories}.ts`, `transports/HTTPClientTransport.ts` + tests                    | `implementer` (Sol)    | U3                      |
| U6   | Guide + parity + **Declared non-goals** section (names every §5 exclusion and the Origin policy split) + a separate **Declared conformance gaps** section covering **both** gaps (`Mcp-Param-*` client projection: the §1.4.6 clause, the consumer-visible cost, U7 as its closer — §5.1.9; and tool-invocation rate limiting: the 2025-11-25 clause, the consumer's own obligation, no closer inside this package — §5.1.10); Contract clauses for the wire-name rule, the discriminator (**key presence**, §4.1), the header scope (`Mcp-Name` on named methods only), the per-era status map, the three supported revisions, and the settled three-case headerless-POST rule (§4.2); `## Methods` bijection covers `discover` | `guides/src/mcp.md` structure, voice, and new sections                                                               | `implementer` (Opus 5) | U0–U5                   |
| U7   | `Mcp-Param-*` (NOT scheduled; only if §8.2 evidence flips the exclusion): first widens `ClientTransportInterface.send`, deliberately last so nothing depends on it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                    | —                      | U6                      |

**Amended 2026-07-31 during U1 — two interface members move to their implementing units.** The
U1 row above said "§4.3 types", which read as _every_ §4.3 declaration including the two that
add members to an interface a concrete class implements. Those two cannot land in a
types-only unit: `MCPClientInterface.version` and `discover()` break `MCPClient` (and therefore
`createMCPClient`), and the `request` event tuple's new `era` element breaks `MCPServer` —
verified by compile probe as `TS2420`, `TS2554`, and `TS2739`. Satisfying them from U1 would
mean either editing another unit's files or leaving a placeholder, and a placeholder is
precisely the "empty stub / deferred logic" `AGENTS.md` forbids.

So the members travel with their implementations: **`MCPClientInterface.version` and
`discover()` move to U3** (which owns `MCPClient`), and **the `era` event-tuple element moves to
U2** (which owns `MCPServer`). U1 keeps every standalone type, the constants, the error
extensions, and all five pure leaves — none of which touch either class, because adding
_optional_ keys to `MCPCallResult` and `MCPClientOptions` breaks no implementation. This is
truer to types-first than the original split: a contract member and the code that satisfies it
belong in one unit, so every unit still reaches green on its own.

Order: U0 → U1 → U2 → U3 → U4 → U5 → U6, with the §6.1 amendment units slotting in after U5
and before the guide unit. Each nontrivial unit gets the standard audit chain
(reviewer = Opus design fit; analyst = Sol correctness; checker = mechanical conformance;
independent verifier runs the five gates, including the real-Chromium browser suite for U5).
Key acceptance details preserved from the design pass: modern `tools/call` carries
`resultType` but NO `ttlMs` — while a modern `tools/list` result carries **both** `ttlMs` and
`cacheScope`, which the schema requires and no earlier ledger stated (§4.4, corrected); a
modern request naming `'2024-11-05'` gets `-32022` with exact
`supported`/`requested`; `_meta` with version but no capabilities ⇒ `-32602`; **a `_meta`
version key holding a non-string value ⇒ `-32602`, never legacy dispatch** (§4.1); legacy
responses byte-identical to pre-change golden strings; a modern POST through
`createMCPSession` reaches the route (200) with `Mcp-Session-Id` ignored; `-32022` triggers
exactly one retry with a NEW id and no third attempt; a `resultType: 'input_required'` result
throws an `MCPError` naming it; **a modern `tools/list` POST carries `MCP-Protocol-Version`
and `Mcp-Method` and NO `Mcp-Name`, and ingress accepts it** (§1.4.6).

### 6.1 Amendment units (§5.1)

Additive. U0–U5 are unchanged, run first, and remain the prerequisite for everything here;
U6 remains the sole owner of the guide's structure, voice, and new sections, and now documents
the A-unit surface and the amended non-goals alongside its original scope. Each A unit updates
the guide's mechanical symbol references for what it changes, under the same sequencing ruling
as the U units (§6). Same rules as above: one writer at a time, clean committed baseline,
disjoint owned files, mirrored `tests/src/**` per unit.

| Unit | Content                                                                                                                                                                                                                                                                                                                                                                          | Owned files                                                                                                                | Engine                 | Depends on               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------ |
| A1   | Method seam (§5.1.5) **and the revised signatures (§4.3)**: `MCPDispatchOptions`, `MCPStream`/`MCPTextStream`, `MCPMethodHandler`; `dispatch`/`handle` gain the optional options parameter and the stream return arm; `server/discover`, `tools/list`, `tools/call` registered through the same mechanism that dispatches them; unregistered ⇒ `-32601`; legacy branch untouched | `src/core/{types,MCPServer,helpers,index}.ts` + tests                                                                      | `implementer` (Opus 5) | U5                       |
| A2   | Protocol-native results (§5.1.4): `structuredContent` alongside the text block on `tools/call`; `outputSchema` explicitly NOT added                                                                                                                                                                                                                                              | `src/core/{types,helpers}.ts` + tests                                                                                      | `implementer` (Sol)    | U5 (serialize after A1)  |
| A3   | MRTR production (§5.1.1): `ElicitRequest` only; `InputRequiredResult` shape; `inputResponses` + byte-exact `requestState` on retry; signed-state round-trip through `@orkestrel/server`'s `signToken`/`verifyToken`; server-side `-32021`                                                                                                                                        | `src/core/{types,constants,parsers,validators,helpers,MCPServer}.ts` + tests                                               | `implementer` (Sol)    | A1, A2                   |
| A4   | `subscriptions/listen` + `_meta.subscriptionId` (§5.1.2), returned as an `MCPStream`: acknowledged-first stream, per-notification stamping, close frame carrying `resultType` plus the required `_meta` subscription id (§5.1.2, corrected); modern-only. **No supersession behavior: MCP defines no subscription key, so there is none to build (§5.1.2)**                      | `src/core/{types,constants,helpers,MCPServer}.ts`, held-open stream seam in `src/server/{handlers,middlewares}.ts` + tests | `implementer` (Sol)    | A1                       |
| A5   | Disconnect-cancellation (§5.1.6): the request's abort signal reaches the dispatched handler through `MCPDispatchOptions.signal` (§4.3, landed in A1); closed HTTP response stream = cancellation; stdio keeps `notifications/cancelled`; no HTTP client→server notifications                                                                                                     | `src/core/{types,MCPServer}.ts`, `src/server/{types,handlers,middlewares}.ts`, `src/browser/{types,helpers}.ts` + tests    | `implementer` (Sol)    | A1, A4                   |
| A6   | Hostile-input limits + protocol-faithful fixtures (§5.1.7): bounded message bytes, `_meta` size/key count, `requestState` size, content size, live subscriptions; configurable with secure defaults; fixture peers on the wire                                                                                                                                                   | `src/core/{types,constants,parsers}.ts`, `src/server/{types,constants,handlers}.ts`, `tests/fixtures/**` + tests           | `implementer` (Sol)    | A2, A3, A4, A5           |
| A7   | Tasks extension (§5.1.3) — **NOT scheduled**; adopt only once a client that negotiates `io.modelcontextprotocol/tasks` exists: `tasks/get`/`tasks/update`/`tasks/cancel`, unsolicited `CreateTaskResult`, injected task store                                                                                                                                                    | —                                                                                                                          | —                      | A1; a negotiating client |

Order: U0 → U1 → U2 → U3 → U4 → U5 → A1 → A2 → A3 → A4 → A5 → A6 → U6. A7 is unscheduled by
construction, exactly like U7, and both remain droppable without loss of any promised
capability.

### 6.2 Amendment acceptance criteria

- **A1** — a method registered after construction dispatches; an unregistered modern method
  still returns `-32601`; the three built-in modern methods are registered through the seam
  (grep proves no second dispatch path); every legacy response stays byte-identical to its
  pre-change golden string. Signatures: `dispatch(request)` and `handle(message)` still
  compile and behave identically with the options argument omitted; a handler returning an
  `MCPStream` is narrowed at exactly one site per boundary; an aborted `options.signal` is
  observable inside a registered handler (A5 proves it over a real transport).
- **A2** — a `tools/call` result carries `structuredContent` AND the text block; a value-less
  result still produces a valid result; `tools/list` descriptors carry no `outputSchema`; the
  modern `tools/call` result still carries `resultType` and no `ttlMs` (the §6 rule holds),
  while the modern `tools/list` result carries both `ttlMs` and `cacheScope` (§4.4); the
  response type stays the union `CallToolResult | InputRequiredResult` so A3 can write into it
  unchanged.
- **A3** — an `input_required` result validates against the spec shape with exactly one
  `ElicitRequest` and no `CreateMessageRequest`/`ListRootsRequest`, and carries at least one of
  `inputRequests` or `requestState`; `inputRequests` serializes as a **map** of
  server-assigned keys, never an array (§5.1.1); `requestState` is a **string** and the retry
  carries `inputResponses` and `requestState` **top-level in `params`**, siblings of `name` and
  `arguments`; a retry echoing `requestState` byte-exact is accepted under a NEW id; a mutated
  `requestState` fails `verifyToken` and is rejected, not honored; the signed payload binds
  principal, TTL, and the originating-request identifier; a retry that omits `inputResponses`
  is rejected; a client declaring `elicitation: {}` receives **form mode** and never URL mode,
  and a client that declared no elicitation capability gets `-32021` with exact
  `data.requiredCapabilities` and HTTP 400, never a fabricated result; `InputRequiredResult` is
  produced only on `tools/call` (the sole one of its three legal methods this package
  implements); our own `MCPClient` still throws a named `MCPError` on a foreign
  `input_required` (§4.7).
- **A4** — the first message **carrying a given subscription id** is
  `notifications/subscriptions/acknowledged`, and its `params.notifications` names the
  `SubscriptionFilter` subset the server honours; the assertion is per subscription id, not
  "first message on the wire", because ordering is defined per id and another subscription's
  messages may legally interleave ahead of it on stdio. Every subsequent notification carries
  `_meta['io.modelcontextprotocol/subscriptionId']` equal to the listen request's JSON-RPC id.
  A graceful close ends the `MCPStream` by returning a result carrying `resultType` **and the
  required `_meta` with that subscription id** — not an empty result (§5.1.2, corrected). A
  legacy-era `subscriptions/listen` returns `-32601`. **No supersession criterion, and none is
  pending:** §8.10 established that MCP has no subscription key, no uniqueness rule, no
  supersession permission, and no rejection code, so the provisional rule was withdrawn rather
  than deferred (§5.1.2). A4 asserts nothing about a second listen because the protocol says
  nothing about one; the one-subscription-per-epoch invariant is `@orkestrel/supervisor`'s and
  is tested there.
- **A5** — aborting the HTTP request aborts the `options.signal` the handler observes, proven
  by a real transport rather than a synthesized signal; a stdio `notifications/cancelled` still routes;
  no client→server notification is ever POSTed; a cancelled call reports requested
  cancellation without asserting observed termination.
- **A6** — a message over the byte cap is rejected with a protocol error and never parsed; an
  oversized `_meta`, `requestState`, or content payload is rejected; the subscription cap is
  enforced and its rejection is typed; every limit test drives a real fixture peer over a real
  transport, with no mock, module replacement, or fake clock.
- **A7** (if ever scheduled) — every supervisor capability still passes with the extension
  un-negotiated; a durable id is present in every result whether or not a task id is; no test
  reaches green only on the Tasks path.

---

## 7. Version/publish context

- **Corrected 2026-07-31.** Baseline is `1209eb5` on `main`; package.json is **0.0.8 and
  published**. The proposal-time note ("0.0.6 unpublished; the adoption may ship as 0.0.6
  content") is spent: the branch merged, the §3 conformance fixes landed before the 0.0.7
  bump and ship in 0.0.8, and the dependency set moved to `@orkestrel/tool`. **The adoption
  therefore bumps** — it cannot ship as existing-version content.
- The renames in U0 and the contract growth in §6.1 are breaking, but the package is
  greenfield — no compatibility aliases (repository law).
- Downstream: no published package consumes the negotiation surface beyond the
  `createMCPClient`/`createMCPServer` factories; the `identity` regrouping touches every
  constructor call site in tests/fixtures/guide but nothing published pins the old shape.
  **`@orkestrel/supervisor` does not exist yet** — it is proposed in the workflow
  repository's `PROPOSAL.md` and will be the first consumer to pin the amended surface. That
  ordering is deliberate: this adoption ships and is published before the supervisor depends
  on it, so the supervisor never pins an unreleased shape.
- `@orkestrel/server` (0.0.7) is already a declared peer dependency, so §5.1.1's
  `signToken`/`verifyToken` integrity mechanism adds no dependency to `package.json`.

## 8. Evidence tasks — findings and status

**Run 2026-07-31 against primary sources**: the specification text for the prose questions and
the commit-pinned schema for the shape questions (`modelcontextprotocol@7376311`,
`ext-tasks@2c1425d`, `typescript-sdk@cc4b416`, `python-sdk@a4f4ccd`, `inspector@fb1b0cb`).
Eleven of the twelve are **answered** and carry their finding below; **§8.2 was not part of
this pass and remains open**, and its unit (U7) stays gated on it. Where a finding is inferred
or where the specification is silent, the entry says so in those words — an inference is not
promoted to a quotation by being useful.

1. **2025-03-26 batching normativity.** **Answered; confirmed, with a citation correction.**
   The receiving MUST is real — "MCP implementations **MAY** support sending JSON-RPC batches,
   but **MUST** support receiving JSON-RPC batches" — but it lives on `basic/index` § Batching,
   not on `basic/transports`, which only constrains the client's POST body shape. The removal
   reasoning in §4.2 is unaffected; the citation now points at the right page.
2. **`Mcp-Param-*` binding strength** (gates U7; sizes the declared conformance gap, §5.1.9).
   **STILL OPEN — the one task this pass did not run.** Does the clients-MUST-support clause
   bind all clients or only streamable-HTTP clients? Do real 2026-07-28 servers require
   header-projected params rather than accepting body params? If yes → adopt U7 and widen
   `send`; if no → the gap stays declared and inert. Either way the guide names it as an unmet
   MUST, not as a non-goal — that part was never evidence-gated. U7 may not be scheduled until
   this returns.
3. **Session-middleware passthrough wording.** **Answered; the chosen reading survives on
   better grounds.** The "ignore `Mcp-Session-Id`" guidance is a **SHOULD** explicitly scoped
   to "a server that supports only this revision", so it does not textually bind a dual-era
   server; for a modern POST carrying `Mcp-Session-Id` on a dual-era server the specification
   is **not stated**. Passthrough-and-ignore is nonetheless right, and this is a reasoned
   choice over a silence rather than a quotation: 2026-07-28's Server Validation failure list
   is enumerated and closed — missing required header, header/body mismatch, invalid characters
   — an unexpected _extra_ header is not among them, and `Mcp-Session-Id` is not in the
   required-header table. Rejecting on it would invent a failure condition the spec does not
   define. §4.8's passthrough stands.
4. **`ttlMs: 0` legality, `-32020` data, `x-mcp-header` schema.** **Answered; three
   corrections, all folded into §4.4.** `ttlMs` is **required**, `@minimum 0`, and `0` means
   "immediately stale", not "do not cache"; `ListToolsResult` requires both `ttlMs` and
   `cacheScope`, an obligation no ledger carried; `HeaderMismatchError` declares **no** `data`
   member at all, in deliberate contrast to `UnsupportedProtocolVersionError`'s
   `{ supported, requested }`; and `x-mcp-header` has no schema definition, only prose
   constraints. `DEFAULT_MCP_CACHE_TTL = 60_000` is frozen and §9.6 closes.
5. **2025-11-25 mandatory surface check** (guarded the §4.2 ruling). **Answered; the
   three-item reading is REFUTED and the surface is larger.** Origin→403 and JSON Schema
   2020-12 (three MUSTs, not one) are confirmed; validation-as-execution-error is **struck** —
   `server/tools` § Error Handling carries no server-binding keyword and its only keywords bind
   the client. Additional MUSTs are listed in §4.2. §9.1's revisit condition fired and the
   ruling to keep 2025-11-25 survives, with **one genuine exposure — "rate limit tool
   invocations" — recorded as a declared conformance gap (§5.1.10)**, not as a silent omission.
6. **Reference peer.** **Answered; THE ASSUMPTION IS OVERTURNED and the plan changes.** The
   entry used to read "no reference peer exists; conformance will be self-attested against
   fixtures written from the same spec text". That is false.
   **`@modelcontextprotocol/conformance@0.2.0-alpha.10`** (MIT, Anthropic PBC) documents
   `--spec-version 2026-07-28` and ships an `expected-failures.2026-07-28.yml` baseline.
   Self-attestation was the fallback for having no external oracle, and an external oracle
   exists — so **running the real suite against our server becomes part of this campaign's
   verification, and our fixtures become supplementary rather than the sole evidence**. This is
   the single largest quality improvement the evidence pass bought, because it replaces
   agreement-with-ourselves with a check we did not write. Separately, and marked **inferred,
   not verified**: no public 2026-07-28 reference _server_ appears reachable — the
   organization's hosted endpoint answers but is 401-gated, and TypeScript SDK 1.30.0 still
   declares `LATEST_PROTOCOL_VERSION = "2025-11-25"` with no occurrence of `2026-07-28` in the
   package. The fixture-per-clause pattern (`tests/fixtures/browserServer.ts`) still applies to
   everything the suite does not reach.
7. **Revision drift.** **Answered; none. The ledger is stable.** 2026-07-28 is labelled
   current and `/specification/latest` redirects to it; six revisions are listed;
   `schema/2026-07-28` has exactly two commits, both dated 2026-07-28; `schema/draft` differs
   from it by 38 lines of documentation-link path rewrites and **no type, field, or constraint
   differences**; no errata. One correction to §1.1's framing rather than its content:
   **2025-03-26 is still live on the site**, so its absence from our list is our decision and
   not an upstream withdrawal (§4.2).
8. **Structured tool output obligations** (gated A2). **Answered; A2 proceeds unchanged.** The
   serialized-JSON text block is a **SHOULD**, framed as backwards compatibility; no clause
   gates `structuredContent` on a declared `outputSchema` — recorded as **inferred from the
   absence of a gating clause**, since no source states the permission affirmatively; `content`
   is required and `resultType` inherited-required. New fact: `CallToolResultResponse.result`
   is the union `CallToolResult | InputRequiredResult` (§5.1.4).
9. **MRTR wire shape at depth** (gated A3). **Answered; three shape corrections and one new
   constraint**, all folded into §5.1.1 and §6.2: `inputRequests` is a **map**, not an array;
   `requestState` is a **string**, not bytes, integrity-protected with principal, TTL, and
   originating-request identifier inside the protected payload; the echo is **top-level in
   `params`**; and elicitation modes are capability-gated, with an empty capabilities object
   meaning form mode only. `InputRequiredResult` is legal only on `prompts/get`,
   `resources/read`, and `tools/call`, and MUST carry at least one of `inputRequests` or
   `requestState`. The second half of the question — whether an elicitation-only server owes
   anything to a client that declared sampling or roots — is **not stated**: no clause imposes
   a duty toward a capability we never advertise.
10. **Subscription lifecycle at depth** (gated A4). **Answered — and the blocking half came
    back "not stated" in a way that WITHDRAWS the rule rather than deferring it.** MCP has no
    concept of a subscription key: identity is the JSON-RPC request id of the
    `subscriptions/listen` request, the only multiplicity text is "a client MAY have multiple
    active subscriptions concurrently", and there is no uniqueness rule, no supersession
    permission, and no rejection error code. §5.1.2's provisional supersession rule presumed a
    mechanism the protocol does not have and is withdrawn; §6.2 removes the criterion rather
    than carrying it as pending. Verified alongside it: the acknowledgement is
    `notifications/subscriptions/acknowledged` with `params.notifications`, first **per
    subscription id** (ordering is per id, not per channel); the correlation key is the listen
    request's id; and graceful closure is **not** an empty complete result —
    `SubscriptionsListenResult._meta` is required and carries the subscription id.
11. **Tasks extension per-method shapes** (gates A7). **Answered; the expected answer was
    FALSE.** A client that negotiates the extension **does** exist — MCP Inspector 2.0.0
    advertises `io.modelcontextprotocol/tasks` by default, published to npm as `latest` — so
    A7's stated trigger fired. It is re-ruled in §5.1.3 rather than ignored: A7 stays
    unscheduled on the corrected trigger **a consumer that needs it**, because the schema is
    still `draft`, both official SDKs refuse the methods, and an inspector advertising by
    default demonstrates the wire rather than demand. The per-method wire shapes are verified
    and recorded in §5.1.3 for whenever it is scheduled; `tasks/list` and blocking
    `tasks/result` are confirmed removed.
12. **Headerless post-initialize legacy POST** (gated U4). **Answered; SETTLED, and the
    precautionary withdrawal is vindicated.** The defaulting SHOULD is scoped by "and has no
    other way to identify the version - for example, by relying on the protocol version
    negotiated during initialization", which names the negotiated version as its own example of
    having another way; the adjacent `400` MUST fires on a bad header _value_, and on a
    _missing_ header the legacy revisions are silent; 2026-07-28 requires a server that does
    not serve pre-2025-06-18 clients to reject a headerless request per Server Validation.
    §4.2 now carries the quotations and the three-case ingress rule, and §4.8 implements it.
    Defaulting to 2025-06-18 stays ruled out — now on evidence rather than on caution.

## 9. Adversarial record (dissents preserved)

1. **2025-11-25 support** — analyst: support (tools-only mandatory behavior attainable;
   final handshake-era revision; best legacy counterpart). Planner: exclude (half its
   additions are removed again by 2026-07-28; 2025-11-25 clients can downgrade to
   2025-06-18; building toward a superseded-in-place revision is speculation).
   **Ruling: support** — the tiny mandatory delta buys handshake compatibility with the
   dominant deployed client population; optional surfaces are not adopted. Evidence task
   §8.5 guards the ruling. **Amended 2026-07-31:** §8.5 returned and the delta is **not**
   tiny — one of the three claimed items is refuted outright and the real surface adds tools
   capability declaration, `inputSchema` validity, the full base-protocol and lifecycle MUSTs,
   the `security_best_practices` MUSTs, and four `server/tools` security MUSTs (§4.2). The
   revisit condition this entry wrote for itself therefore fired. **The ruling survives
   unchanged**, because everything added is already satisfied or is generic behavior this
   package implements regardless — except **"rate limit tool invocations"**, which is product
   policy and is now a declared conformance gap (§5.1.10). The planner's dissent gains a fact
   it did not have and still does not carry the decision: a larger mandatory surface that we
   already meet is not a reason to abandon the handshake-era population, and the one clause we
   do not meet is declared rather than hidden.
2. **Origin validation** — analyst: implement (spec MUST; real trust boundary). Planner:
   exclude as consumer obligation (guide already documents CORS/auth as fronting middleware;
   product policy). **Ruling: implement the minimal gate** (mechanism: same-origin default +
   `origins` allowlist; policy — the list — remains the consumer's), because the MUST binds
   the server component this package ships.
3. **`Mcp-Param-*`** — analyst: implement (conformance; filter invalid tools). Planner:
   decline (architectural leak of HTTP into the transport-agnostic port; implementing only
   the filter half hides tools with no compensating capability). **Ruling: exclude from the
   first campaign, isolate as U7, decide on §8.2 evidence.** **Amended 2026-07-31:** the
   scheduling is untouched, but the analyst was right that this is a conformance question and
   the word "exclude" was wrong for it — §1.4.6 makes the client projection a MUST, so it is
   recorded as a declared conformance gap (§5.1.9). The planner's filter-half objection is
   answered separately: with no `x-mcp-header` in any installed tool definition, the
   server-side filter is vacuous and hides nothing.
4. **Dispatch context parameter** — analyst: add `MCPDispatchContext` for per-binding legacy
   pinning. Planner: keep `dispatch(request)` — legacy responses are revision-invariant on
   this surface. **Ruling: planner** (simpler contract); the HTTP session middleware pins
   versions at its own layer. **Amended 2026-07-31:** the ruling holds on its stated ground —
   no version travels on the parameter — but a second parameter now exists anyway, because
   A5's abort signal has nowhere else to ride. §4.3 adds `MCPDispatchOptions { signal? }`,
   optional at every call site. The analyst's arity was right for a reason neither engine
   argued at the time; its payload was not adopted and legacy pinning stays at the session
   layer.
5. **Naming set** — planner's shape adopted wholesale (subjective domain per the engine
   split): `MCPIdentity` regrouping, operation-named results, `MCPVersion`/`MCPEra`, no
   `send()` widening; analyst's additional `buildJSONRPCResult`/`buildJSONRPCError` renames
   adopted as consistent with the same `{verb}{Noun}` rule.
6. **Cache TTL default** — analyst: `0` pending schema check; planner: `60_000`. **Ruling:
   `60_000` provisionally; §8.4 settles it.** Scope `'private'` default is agreed by both.
   **Closed 2026-07-31:** §8.4 returned. `0` is schema-legal (`@minimum 0`), so the analyst's
   proposal was not illegal — but it does not mean what it was proposed to mean. A `0` says the
   result SHOULD be considered immediately stale and the client MAY re-fetch each time; it is a
   staleness hint, never a "do not cache" instruction. The condition the provisional ruling was
   held open against is spent, so **`60_000` is final** and `ttlMs` is confirmed required on
   every result that carries it.

## 10. How to resume

1. Read this document top to bottom; it inlines everything (the research distillate, the
   verified inventory, both designs' substance, the reconciliation, the 2026-07-31 amendment
   in §5.1/§6.1, and the 2026-07-31 evidence pass folded into §4, §5.1, §6.2, and §8).
2. **The §8 evidence pass is done** (2026-07-31): eleven of twelve tasks are answered and each
   finding is already folded into the section it corrects, so no unit is waiting on evidence.
   **§8.2 alone stays open** and gates U7, which is unscheduled anyway. The two former hard
   gates are discharged in opposite ways: §8.12 settled U4's headerless rule into three cases
   (§4.2), and §8.10 **withdrew** A4's supersession criterion rather than setting it, because
   MCP defines no subscription key (§5.1.2, §6.2).
3. **Run `@modelcontextprotocol/conformance` with `--spec-version 2026-07-28` as part of
   verification** (§8.6). An external oracle exists; self-attestation against our own fixtures
   is no longer the plan, and our fixtures are the supplement that covers what the suite does
   not reach.
4. Re-verify the §1.1 ledger against `/specification/latest` — stable as of 2026-07-31 (§8.7),
   so this is a cheap re-confirmation rather than a research task.
5. Execute U0 → U5, then the §6.1 amendment units A1 → A6, then U6, under the repository's
   operating contract (serialized writers from clean baselines, adversarial audits,
   independent verifier gates, real-Chromium browser suite for U5). Each unit carries its own
   mechanical guide updates so parity stays green throughout (§6). U7 and A7 stay unscheduled:
   U7 until §8.2 returns, A7 until a consumer needs it (§5.1.3, corrected trigger).
6. Branch from `1209eb5` on `main`, fast-forward on completion, and publish before
   `@orkestrel/supervisor` pins the surface (§7).
