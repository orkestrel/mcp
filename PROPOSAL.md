# PROPOSAL — MCP 2026-07-28 adoption and multi-version support

> Status: **adoption not implemented; §3 conformance fixes shipped.** Produced 2026-07-28
> from live primary-source research and a full adversarial design pass (Opus 5 planner vs
> GPT-5.6 Sol analyst on the same brief, reconciled by the orchestrator). The 2026-07-28
> adoption itself is deferred to a dedicated session by the owner's decision. Baseline when
> written: `b77ee07` (branch + main), version 0.0.6 unpublished. Replaces the previous
> PROPOSAL.md (environment-agnostic faces), which shipped fully with 0.0.6 and remains in
> git history at `a2f983b`. This document is self-contained; the session journals behind it
> were ephemeral.
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
   closure = empty complete result.
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

  > A request is modern **iff** `params._meta['io.modelcontextprotocol/protocolVersion']`
  > is present. Nothing else.

  This single rule is load-bearing: a legacy 2025-06-18 request may legally carry
  `_meta.progressToken`, so keying on "`_meta` exists" would misclassify it. Keying on the
  version token keeps legacy `_meta` working and makes "present but incomplete" exactly the
  modern `-32602` case.

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

| Revision   | Ruling                                             | Why                                                                                                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | **Support — default, modern era**                  | `/specification/latest`; its mandated tools-only surface is fully implementable with zero speculative capability.                                                                                                                                                                            |
| 2025-11-25 | **Support — legacy era** (planner dissented; §9.1) | Site-labeled "current"; the dominant deployed client population today. Tools-only mandatory delta is tiny: Origin→403 on the HTTP face, 2020-12 dialect, validation-as-execution-error. Optional surfaces (tasks, icons, URL elicitation, SSE polling) are NOT adopted and never advertised. |
| 2025-06-18 | **Support — legacy era**                           | The currently implemented revision; the legacy anchor the widest older ecosystem speaks.                                                                                                                                                                                                     |
| 2025-03-26 | **Remove** (both engines agree; source-verified)   | Advertised today while its batching MUST is violated (§3.3). Delete the row rather than implement batching that 2025-06-18 removed again. Consequence: a headerless legacy HTTP request is treated as 2025-06-18, the only honest reading once pre-2025-06-18 support is dropped.            |
| 2024-11-05 | **Exclude** (both agree)                           | Requires the HTTP+SSE two-endpoint transport this package never implemented and 2026-07-28 deprecates. Advertising the version without its transport is a false handshake.                                                                                                                   |

The list order is meaningful: it is the client's preference order and the `server/discover`
advertisement.

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
- `ClientTransportInterface.send`: **batch arm deleted** — `send(message: JSONRPCMessage)`.
  2026-07-28 forbids batching, no caller uses the array arm, and deletion enforces the MUST
  in the type system. (Also delete the array fan-out in `createDuplexClientTransport`.)
- No `MCPCapabilities` type: capabilities stay `Readonly<Record<string, unknown>>` (open
  wire record; a named type would also force a pluralized type name).

New error contract (`src/core/errors.ts`, new file):
`class MCPError extends Error { readonly code: number; readonly context: unknown }` +
`isMCPError`. Carries JSON-RPC `code` and `data` so the `-32022` retry can read
`data.supported`. Required by `typescript.md`'s error rules; fixes gap §3.5.

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
`ToolManager` is per-tenant; `'public'` is opt-in. (Analyst preferred `ttl: 0`; evidence task
§8.4 settles whether `0` is schema-legal before freezing the default.)

Server face (`src/server/constants.ts`): `MCP_METHOD_HEADER = 'mcp-method'`,
`MCP_NAME_HEADER = 'mcp-name'`; `MCP_PROTOCOL_VERSION_HEADER` becomes load-bearing. Browser
face gets the same header constants in `src/browser/constants.ts`.

### 4.5 Pure leaves, by kind

| File                           | Symbol                                                                                      | Contract                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/validators.ts`       | `isModernRequest`                                                                           | Total; `true` iff `_meta[MCP_META_VERSION]` is a string. The discriminator.                                                                                   |
| `src/core/parsers.ts`          | `parseRequestContext`                                                                       | Total coercer → `MCPRequestContext \| undefined`. Soundness pair: defined ⇒ `isModernRequest` true; guard-true + undefined parse = exactly the `-32602` case. |
| `src/core/inferers.ts` (new)   | `inferEra(version)`                                                                         | Revision→era; unsupported ⇒ `undefined`.                                                                                                                      |
| `src/core/helpers.ts`          | `buildInitializeResult` (rename of `initializeResult`)                                      | Negotiates over the LEGACY subset only — `initialize` asking for `'2026-07-28'` gets the newest legacy version back; the client decides.                      |
| `src/core/helpers.ts`          | `buildDiscoverResult`, `buildModernResult`, `buildCallResult` (rename of `buildToolResult`) | `buildModernResult` is the ONE stamping site for `resultType` + `_meta` serverInfo + (when ttl supplied) `ttlMs`/`cacheScope`.                                |
| `src/core/helpers.ts`          | `buildJSONRPCResult` / `buildJSONRPCError` (renames of `jsonRPCResult` / `jsonRPCError`)    | `{verb}{Noun}` conformance, matching the other builders.                                                                                                      |
| `src/server/inferers.ts` (new) | `inferStatus(error, era)`                                                                   | The per-era HTTP status map; keeps status semantics out of core.                                                                                              |

### 4.6 `MCPServer` — one dispatch, two branches

```text
era = isModernRequest(request) ? 'modern' : 'legacy'
emit('request', method, id ?? null, era)
notification (no id) ⇒ undefined (unchanged)
modern branch:
  parseRequestContext undefined        ⇒ -32602
  version ∉ SUPPORTED                  ⇒ -32022 { supported, requested }
  methods: server/discover, tools/list, tools/call; all else (incl. initialize, ping) ⇒ -32601
  every result through buildModernResult; discover + tools/list carry cache fields, tools/call does not
legacy branch: today's switch, byte-identical responses (no resultType, no cache fields)
```

`-32021` is never emitted (no implemented method requires a client capability — nothing here
elicits, samples, or reads roots); the constant and `MCPError` recognition still ship because
the **client** must understand it from foreign servers. Core dispatch stays stateless for
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
  else (`'input_required'`, `'task'`, unknown) ⇒ throw `MCPError` naming it. We do not
  implement MRTR, and silently reading an `input_required` result as tool output would hand
  a model fabricated results.

### 4.8 Transport faces

- **Node HTTP ingress** (`handlers.ts`, new `inferers.ts`, `middlewares.ts`):
  - Modern POST: `MCP-Protocol-Version` REQUIRED and MUST equal body `_meta` version;
    `Mcp-Method` REQUIRED = body method; `Mcp-Name` REQUIRED on `tools/call` = `params.name`.
    Violation ⇒ 400 + `-32020`.
  - Status map (modern only): 202 notification; 400 for `-32020`/`-32021`/`-32022`/`-32602`;
    404 for `-32601`; 200 otherwise. Legacy requests keep today's uniform 200 in-band errors
    — nothing regresses.
  - Headerless legacy POST ⇒ treated as 2025-06-18 (only honest reading; §4.2).
  - Origin gate: same-origin/no-origin allowed by default; cross-origin requires explicit
    `origins` allowlist option; invalid ⇒ 403. Mechanism only — which origins is consumer
    policy. (Planner dissented; §9.2.)
  - SSE responses gain `X-Accel-Buffering: no`.
  - **`createMCPSession` passes modern-shaped POSTs straight through via `next()`, ignoring
    `Mcp-Session-Id`** (fixes gap §3.4); it stays the legacy session layer otherwise and pins
    each session's negotiated legacy version.
- **Both HTTP client transports** (Node + browser) set the three headers on every POST — all
  derivable from the message the transport already holds, so `send(message)` needs no
  widening. Session echo stays legacy-only.
- **WebSocket, stdio, MessagePort**: no changes — no headers; era rides in `_meta`.
  `serveMCP` inherits dual-era for free because it composes the core server.

### 4.9 Rejected alternatives (on the record)

- **Two server classes (legacy + modern)**: a dual-era endpoint would need both mounted
  behind one route with hand-rolled discrimination; duplicates registry binding and breaks
  one-concept-one-term.
- **Construction-time `era` option**: is precisely the cross-request inference the
  statelessness doctrine forbids, hoisted a level; unknowable for a public endpoint;
  a stored label that can disagree with the request in hand.
- **`MCPDispatchContext` on `dispatch`/`handle`** (analyst): unnecessary while legacy
  responses are revision-invariant on the tools-only surface; recorded as the fallback.
- **Widening `send(message, context?)`** (analyst): needed only by `Mcp-Param-*` projection;
  see §8.2 before ever adopting.

---

## 5. Scope matrix (reconciled)

"Implement" = shipped and tested in the adoption campaign. "Exclude" = intentionally absent
AND named in the guide's new **Declared non-goals** subsection — never silently dropped.

| Feature                                                                           | Ruling                                                                 | Reason                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-request `_meta` (version/capabilities REQUIRED; clientInfo/serverInfo SHOULD) | Implement                                                              | Mandatory; the discriminator itself.                                                                                                                                                                                                                    |
| `_meta.progressToken`                                                             | Implement as passthrough                                               | Must not be misread as a modern marker; we neither generate nor consume progress.                                                                                                                                                                       |
| `_meta.logLevel`, `_meta.subscriptionId`                                          | Exclude                                                                | Belong to logging (deprecated) and subscriptions (excluded).                                                                                                                                                                                            |
| W3C `traceparent`/`tracestate`/`baggage`                                          | Exclude                                                                | Tracing is application policy; the `request` event is the observation seam; consumers stamp their own.                                                                                                                                                  |
| `server/discover`                                                                 | Implement                                                              | Mandatory server RPC; surfaced as `client.discover()` (instructions otherwise unreachable).                                                                                                                                                             |
| `resultType` on every modern result                                               | Implement                                                              | Mandatory; one stamping site; client treats absent as complete.                                                                                                                                                                                         |
| MRTR production (`inputRequests`/`requestState`)                                  | Exclude; **detection implemented**                                     | Needs elicitation/sampling/roots — none exist, all deprecated or absent. Non-`'complete'` results throw a named `MCPError` instead of masquerading as tool output.                                                                                      |
| `subscriptions/listen`                                                            | Exclude                                                                | No change-notification producer exists (`ToolManager` is event-free); held-open streams don't fit one-request→one-response dispatch. Zero consumers.                                                                                                    |
| `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` headers                          | Implement (both HTTP faces + ingress validation)                       | REQUIRED; derivable from the in-hand message; closes gap §3.1.                                                                                                                                                                                          |
| `Mcp-Param-*` + `x-mcp-header` + Base64 encoding                                  | **Exclude — knowingly declined; decision deferred to evidence** (§8.2) | Projection requires the tool schema (client-only knowledge) reaching the HTTP transport — an HTTP-shaped widening of the transport-agnostic port across seven implementations. Isolated as an optional final unit (U7) so it stays droppable/adoptable. |
| HTTP status mapping (202/400/403/404/405)                                         | Implement (modern-scoped)                                              | Legacy keeps today's uniform 200 in-band errors; modern gets the exact codes. 405 GET/DELETE is already true of a session-free mount — documented, not coded.                                                                                           |
| `X-Accel-Buffering: no` + SSE comment keep-alives                                 | Implement                                                              | SHOULD; trivial; comment-flush idiom already exists.                                                                                                                                                                                                    |
| `-32020`                                                                          | Implement (HTTP face emits)                                            |                                                                                                                                                                                                                                                         |
| `-32021`                                                                          | Constant + client recognition only                                     | Server never emits it — no implemented method requires a client capability.                                                                                                                                                                             |
| `-32022` + data                                                                   | Implement both directions                                              | Server emits `{ supported, requested }`; client retries once with new id.                                                                                                                                                                               |
| Retired `-32002`/`-32042` MUST NOT emit                                           | Already true; add policy assertion                                     | Neither is emitted today.                                                                                                                                                                                                                               |
| `CacheableResult` on `tools/list` + `server/discover`                             | Implement                                                              | The only two cacheable results this package produces. `cache` option; default scope `'private'`.                                                                                                                                                        |
| Deterministic `tools/list` order                                                  | Contract + parity assertion, no code                                   | Registry insertion order is already deterministic and is the caller's intent.                                                                                                                                                                           |
| `extensions` capability field                                                     | Exclude                                                                | No extension implemented; capabilities stay an open record so consumers can still declare their own.                                                                                                                                                    |
| Tasks extension                                                                   | Exclude                                                                | An extension with zero consumers; foreign `resultType: 'task'` caught by detection rule.                                                                                                                                                                |
| Resources / Prompts / Roots / Sampling / Elicitation / Logging                    | Exclude                                                                | No registries/consumers; roots/sampling/logging deprecated in 2026-07-28. Local emitters remain observability, not an MCP logging capability.                                                                                                           |
| Icons (2025-11-25)                                                                | Exclude                                                                | Installed `@orkestrel/agent` tool definitions carry no icon field; an MCP-only wrapper has no originating consumer.                                                                                                                                     |
| Structured tool output (`outputSchema`/`structuredContent`)                       | Exclude for now                                                        | The installed `ToolResult` exposes untyped `value`; adoption belongs first in the tool contract that owns it. Text content remains valid.                                                                                                               |
| SSE polling / resumability                                                        | Legacy-only (existing session middleware), unchanged                   | Modern requests must not use it; the broader optional 2025-11 polling protocol has no consumer.                                                                                                                                                         |
| Origin → 403                                                                      | Implement minimal gate (`origins` option, secure default)              | Spec MUST on the server component this package ships; policy (the list) stays with the consumer. Planner dissent §9.2.                                                                                                                                  |
| Batching removal                                                                  | Implement by deletion                                                  | Batch arm removed from `send`; 2025-03-26 dropped; MUST enforced in types.                                                                                                                                                                              |
| `initialize`/`ping`/sessions/GET-stream                                           | Legacy-only (dual-era)                                                 | Present in legacy; `-32601`/405 in modern.                                                                                                                                                                                                              |

---

## 6. Unit decomposition and routing ledger

Strictly serialized writers, each from a clean committed baseline. Every unit owns its
mirrored `tests/src/**` files. `guides/src/mcp.md` is off-limits to every unit but U6.
Engines per the operating contract: Sol = objective implementation (via `codex` role,
journaled exec); Opus = subjective/documentation-voice; Sonnet `builder` = fully specified
mechanical; `verifier` = gates.

| Unit | Content                                                                                                                                                                                                                                                                                                                                                                                                                              | Owned files                                                                                                          | Engine                 | Depends on              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------- |
| U0   | Rename sweep, zero behavior change: `MCPToolResult`→`MCPCallResult`, `buildToolResult`→`buildCallResult`, `initializeResult`→`buildInitializeResult`, `jsonRPCResult`/`jsonRPCError`→`buildJSONRPCResult`/`buildJSONRPCError`, `MCPServerInfo`→deleted, `name`+`version`→`identity` (both options bags + server interface), `description`→`instructions`, delete batch arm of `send` + array branch of `createDuplexClientTransport` | core/server/browser sources + all touched tests                                                                      | `builder` (Sonnet)     | —                       |
| U1   | Modern contract + pure leaves: §4.3 types, §4.4 constants, `errors.ts`, `isModernRequest`, `parseRequestContext` (soundness both directions), `inferEra`, `buildDiscoverResult`, `buildModernResult`                                                                                                                                                                                                                                 | `src/core/{types,constants,validators,parsers,inferers,errors,helpers,index}.ts` + tests                             | `implementer` (Sol)    | U0                      |
| U2   | Dual-era server dispatch (§4.6)                                                                                                                                                                                                                                                                                                                                                                                                      | `src/core/MCPServer.ts` + test                                                                                       | `implementer` (Sol)    | U1                      |
| U3   | Dual-era client (§4.7): discover-first connect, legacy fallback with validated initialize result, `version` getter, `discover()`, `MCPError` surfacing, one-retry `-32022`, result-type safety                                                                                                                                                                                                                                       | `src/core/MCPClient.ts` + test                                                                                       | `implementer` (Sol)    | U1 (serialize after U2) |
| U4   | Node HTTP conformance (§4.8): header validation, status map, Origin gate, session passthrough for modern POSTs, session version pinning, client-transport headers, `X-Accel-Buffering`                                                                                                                                                                                                                                               | `src/server/{handlers,helpers,inferers,constants,types,middlewares}.ts`, `transports/HTTPClientTransport.ts` + tests | `implementer` (Sol)    | U2, U3                  |
| U5   | Browser face parity: same three headers on the fetch transport; environment isolation proven                                                                                                                                                                                                                                                                                                                                         | `src/browser/{types,constants,helpers,factories}.ts`, `transports/HTTPClientTransport.ts` + tests                    | `implementer` (Sol)    | U3                      |
| U6   | Guide + parity + **Declared non-goals** section (names every §5 exclusion incl. `Mcp-Param-*` with its rationale and Origin policy split); Contract clauses for the wire-name rule, the discriminator, the per-era status map, the three supported revisions; `## Methods` bijection covers `discover`                                                                                                                               | `guides/src/mcp.md`                                                                                                  | `implementer` (Opus 5) | U0–U5                   |
| U7   | `Mcp-Param-*` (NOT scheduled; only if §8.2 evidence flips the exclusion): first widens `ClientTransportInterface.send`, deliberately last so nothing depends on it                                                                                                                                                                                                                                                                   | —                                                                                                                    | —                      | U6                      |

Order: U0 → U1 → U2 → U3 → U4 → U5 → U6. Each nontrivial unit gets the standard audit chain
(reviewer = Opus design fit; analyst = Sol correctness; checker = mechanical conformance;
independent verifier runs the five gates, including the real-Chromium browser suite for U5).
Key acceptance details preserved from the design pass: modern `tools/call` carries
`resultType` but NO `ttlMs`; a modern request naming `'2024-11-05'` gets `-32022` with exact
`supported`/`requested`; `_meta` with version but no capabilities ⇒ `-32602`; legacy responses
byte-identical to pre-change golden strings; a modern POST through `createMCPSession` reaches
the route (200) with `Mcp-Session-Id` ignored; `-32022` triggers exactly one retry with a NEW
id and no third attempt; a `resultType: 'input_required'` result throws an `MCPError` naming
it.

---

## 7. Version/publish context

- Baseline `b77ee07`; package.json 0.0.6 **unpublished** at proposal time. If 0.0.6 is still
  unpublished when implementation lands, the adoption may ship as 0.0.6 content; otherwise
  bump. The renames in U0 are breaking but the package is greenfield — no compatibility
  aliases (repository law).
- Downstream: no fleet package currently consumes the negotiation surface beyond
  `createMCPClient`/`createMCPServer` factories; the `identity` regrouping touches every
  constructor call site in tests/fixtures/guide but no external package pins the old shape.

## 8. Open questions — evidence tasks for the implementation session

1. **2025-03-26 batching normativity** (sharpens an already-made removal): confirm the exact
   MUST/SHOULD wording for receiving batches in 2025-03-26 `basic/transports`. Removal stands
   on the two-endpoint/OAuth lineage regardless.
2. **`Mcp-Param-*` binding strength** (gates U7): does the clients-MUST-support clause bind
   all clients or only streamable-HTTP clients? Do real 2026-07-28 servers require
   header-projected params rather than accepting body params? If yes → adopt U7 and widen
   `send`; if no → the guide's declared non-goal stands.
3. **Session-middleware passthrough wording**: "modern-only servers ignore `Mcp-Session-Id`" —
   confirm it binds dual-era servers with a mounted session layer (chosen reading:
   passthrough + ignore) vs. a 400 reading.
4. **`ttlMs: 0` legality**: is 0 schema-legal (meaning "do not cache")? Settles the
   `DEFAULT_MCP_CACHE_TTL = 60_000` vs `0` default. Also confirm exact
   `HeaderMismatchError.data` shape and `x-mcp-header` schema from
   `schema/2026-07-28/schema.ts`.
5. **2025-11-25 mandatory surface check** (guards the §4.2 ruling): re-verify that a
   tools-only server advertising 2025-11-25 is bound to nothing beyond Origin→403, the
   2020-12 dialect, and validation-as-execution-error. If a larger mandatory surface
   surfaces, revisit §9.1.
6. **No reference peer exists**: conformance will be self-attested against fixtures written
   from the same spec text. Check for an official conformance suite or a published
   2026-07-28 server at implementation start; otherwise cite the quoted spec clause in each
   fixture test name (established fixture pattern: `tests/fixtures/browserServer.ts`).
7. **Revision drift**: 2026-07-28 is the newest revision and the site's "current" label had
   not yet flipped at research time. Re-verify the ledger at implementation start (§1.6
   URLs). All modern behavior is reachable from `src/core/constants.ts` + the `#modern`
   branch, so churn is bounded by construction.

## 9. Adversarial record (dissents preserved)

1. **2025-11-25 support** — analyst: support (tools-only mandatory behavior attainable;
   final handshake-era revision; best legacy counterpart). Planner: exclude (half its
   additions are removed again by 2026-07-28; 2025-11-25 clients can downgrade to
   2025-06-18; building toward a superseded-in-place revision is speculation).
   **Ruling: support** — the tiny mandatory delta buys handshake compatibility with the
   dominant deployed client population; optional surfaces are not adopted. Evidence task
   §8.5 guards the ruling.
2. **Origin validation** — analyst: implement (spec MUST; real trust boundary). Planner:
   exclude as consumer obligation (guide already documents CORS/auth as fronting middleware;
   product policy). **Ruling: implement the minimal gate** (mechanism: same-origin default +
   `origins` allowlist; policy — the list — remains the consumer's), because the MUST binds
   the server component this package ships.
3. **`Mcp-Param-*`** — analyst: implement (conformance; filter invalid tools). Planner:
   decline (architectural leak of HTTP into the transport-agnostic port; implementing only
   the filter half hides tools with no compensating capability). **Ruling: exclude from the
   first campaign, isolate as U7, decide on §8.2 evidence.**
4. **Dispatch context parameter** — analyst: add `MCPDispatchContext` for per-binding legacy
   pinning. Planner: keep `dispatch(request)` — legacy responses are revision-invariant on
   this surface. **Ruling: planner** (simpler contract); analyst's mechanism recorded as the
   fallback if legacy behavior ever diverges by revision; the HTTP session middleware pins
   versions at its own layer.
5. **Naming set** — planner's shape adopted wholesale (subjective domain per the engine
   split): `MCPIdentity` regrouping, operation-named results, `MCPVersion`/`MCPEra`, no
   `send()` widening; analyst's additional `buildJSONRPCResult`/`buildJSONRPCError` renames
   adopted as consistent with the same `{verb}{Noun}` rule.
6. **Cache TTL default** — analyst: `0` pending schema check; planner: `60_000`. **Ruling:
   `60_000` provisionally; §8.4 settles it.** Scope `'private'` default is agreed by both.

## 10. How to resume

1. Read this document top to bottom; it inlines everything (the research distillate, the
   verified inventory, both designs' substance, the reconciliation).
2. Run the §8 evidence tasks first (one research dispatch; cheap).
3. Re-verify the §1.1 ledger against `/specification/latest` (§8.7).
4. Execute U0→U6 per §6 under the repository's operating contract (serialized writers from
   clean baselines, adversarial audits, independent verifier gates, real-Chromium browser
   suite for U5).
5. Push `claude/orkestrel-orchestration-tp0ez7` + fast-forward `main`; flag the publish
   decision per §7.
