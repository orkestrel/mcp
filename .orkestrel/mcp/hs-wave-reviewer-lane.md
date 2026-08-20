**Lane held: subjective** (design fit, API and vocabulary, architecture fit, simplification, guide voice). Claims 6 through 8, ruled against the pinned worktree `/home/user/mcp-audit-wt` at `b404a84` and the wave diff at `/home/user/mcp-audit-wt/tmp/hs-wave-diff.patch`.

---

### Claim 6 — the pin contract's shape holds the design laws, and the `MCPError` context shapes agree with the guide

**CONFIRMED.**

Attacks attempted and failed:

- *A hidden switch or sentinel entered with the pin.* `/home/user/mcp-audit-wt/src/core/MCPClient.ts:127` keeps `#pin: MCPVersion | undefined`, and `:222-223` reads `#pin = requested`, `#offer = requested ?? MCP_MODERN_VERSION`. No `strict` option, no `'none'`, no `-1`. Absence is `undefined` at every reader.
- *Construction refuses too late to be a construction refusal.* The throw at `:205-211` precedes the emitter at `:212` and the transport subscription at `:231`. Read order, not narrative, settles it.
- *A pinned modern client can still reach the legacy fallback.* The fallback lives in the catch at `:702-711`; the pin comparison at `:713-727` sits after that catch closes, so a pin miss throws past it. The guard at `:705` independently excludes `MCP_MODERN_VERSION`.
- *A legacy pin mismatch still writes the handshake's last frame.* `:892-898` throws before `notifications/initialized` at `:912` and before `#version`, `#connected`, and the `connect` emit at `:917-920`.
- *A legacy pin reaches discovery first and downgrades there.* `:675` routes a legacy pin straight to `#initialize`.
- *The context shapes drift from the documented ones.* Construction carries `{ supported: SUPPORTED_PROTOCOL_VERSIONS, requested }` (`:207-210`), a modern miss `{ supported, requested }` (`:719-726`), a legacy mismatch `{ requested, negotiated }` (`:893-897`). `/home/user/mcp-audit-wt/guides/mcp.md:2766-2771` states each of those, by key and by branch.

The vocabulary is one term per fact: `supported`, `requested`, `negotiated`. Reusing `MCP_UNSUPPORTED_VERSION` for a local input refusal is defensible because the two origins reach the caller at different call sites — `createMCPClient` against `await connect()` — and the guide says so in the same sentence that gives the context shape.

### Claim 7 — the refusal split is honest at every answer, coherent with the guide's bare-server paragraph, and `MCPServer.ts` carries no legacy spelling

**CONFIRMED.**

Attacks attempted and failed:

- *`-32601` lies about a method the server has.* `/home/user/mcp-audit-wt/src/core/MCPServer.ts:377-380` reaches `Method not found` only when `this.#methods.method(method)` is `undefined`. A bare server registers no `initialize`, so the refusal states a true fact about that server.
- *`Invalid params: request declares no protocol version` names a condition the code does not test.* `isModernRequest` (`/home/user/mcp-audit-wt/src/core/validators.ts:1934-1941`) tests presence of the reserved key alone, so params that are not a record, `_meta` that is not a record, and an absent key all reduce to the one fact the message names. The malformed-grammar wording stays behind `parseRequestContext` at `:387-397`, reached only after presence has fixed the request as modern — so neither message can be given for the other's condition.
- *The new branch answers a notification.* `#dispatch` returns at `:229` for an absent id, before `#modern` runs, so the branch never builds a response for a notification and never builds one with an absent id.
- *The guide describes a coarser rule than the code enforces.* `/home/user/mcp-audit-wt/guides/mcp.md:2538-2546` states all three answers with their exact messages and names the registered-or-not discriminator that selects between them.
- *A legacy spelling survived the change.* The only match for `legacy` or `initialize` in `/home/user/mcp-audit-wt/src/core/MCPServer.ts` is `notifications/initialized` inside the comment at `:226`, a method name rather than an era term.

The split is better than the ruling that specified it: naming `Method not found: initialize` sends an operator to the missing decorator in one step, and keeping `-32602` for a registered method refuses to claim a method is absent when it is present.

### Claim 8 — the TSDoc and contract prose the Sol units touched keep the writing canon

**CONFIRMED.**

- *First sentences.* `/home/user/mcp-audit-wt/src/core/errors.ts:2-3` stays a noun phrase, matching every other class TSDoc in the module, and the constructor keeps `Creates an MCP protocol error.` at `:30`. The widened remark repairs a false sentence rather than merely relaxing one: `MCPClient.ts:317` and `:345` already threw `MCPError` for locally detected conditions before this wave, so `only for a remote JSON-RPC error response` was untrue when it was written.
- *Banned vocabulary.* Pattern `should|simply|just|eas(y|ier|ily)|via|currently|now|latest|in order to|leverage|utilize|robust|performant|allows you to|and/or|etc\.|since|once|please|dummy|whitelist|blacklist` over added lines of `tmp/hs-wave-diff.patch`, restricted to the published-prose files (`README.md`, `guides/mcp.md`, `src/browser/factories.ts`, `src/core/*`, `src/server/*`, patch lines 1928 through 2464). The hits are patch `:2021` and `:2425`, both the relocated comment `An MCP client now connects over this process's stdio`, where `now` means from this point in the program rather than at the time of writing — the permitted sense, in pre-existing text.
- *Claims a reader can check.* `guides/mcp.md:4135-4141` gives the two reference-server codes, the source links, and the read date `2026-08-20`, and `.orkestrel/mcp/handshake-research-servers.md:9-14` carries each. The passage then states the silent-peer cost separately instead of generalizing the reference behavior, which is the honest bound.
- *One shared term.* `// answers \`initialize\` too; pass \`mcp\` alone for modern-only` is now identical at `README.md:44`, `guides/mcp.md:1975`, `:2194`, `:2288`, `:3055`, `src/server/factories.ts` (routes, WebSocket, stdio), `src/server/handlers.ts:54`, `src/server/middlewares.ts:88`, and `src/browser/factories.ts:118`, replacing the divergent `// both eras; pass \`mcp\` for modern only`. Naming the method a client sends, rather than revision dates, is the currency a skimming consumer can act on.

---

### Findings outside the claims

**F1. Required. `/home/user/mcp-audit-wt/guides/mcp.md:1671` — the `MCPError` surface row still describes the class as remote-only, and now contradicts both the source and the guide's own pin paragraph.**

The row reads `A remote JSON-RPC error preserving its numeric `code` and optional `error.data` as `context`.` The wave changed the owning TSDoc away from exactly that statement (`src/core/errors.ts:6-9`, now `for a remote JSON-RPC \`error\` response and for a locally detected protocol incompatibility`), and added a construction-time throw whose context is `{ supported, requested }` rather than any `error.data` (`src/core/MCPClient.ts:207-210`). The same guide states the local throw at `:2766-2768`. The API index and the contract paragraph disagree about one class, and the index is where a reader looks first — a consumer wrapping `createMCPClient` in a `catch` is told by the row that no `MCPError` can arrive from there.

This is a half-landed prescribed change: `.orkestrel/mcp/handshake-analyst-lane.md:119` assigned `src/core/errors.ts` **and the guide's `MCPError` row`; `.orkestrel/mcp/hs-u1-brief.md:41` carried only the source half, and correctly marked `guides/mcp.md` off-limits at `:78`, and no later brief picked the row up. No gate can see it, because parity proves the name resolves and never that the sentence is true.

Right looks like: `| \`MCPError\` | class | A Model Context Protocol error preserving its numeric \`code\` and optional \`context\` — a remote JSON-RPC \`error.data\`, or the locally detected incompatibility's own detail. |`

**F2. Not required. `/home/user/mcp-audit-wt/guides/mcp.md:1558` generalizes one of the two refusals.**

The modern-only contrast reads `createMCPRoutes(mcp) // modern only — a legacy request falls off the modern seam as -32601`. After the split, only a request naming a method the modern seam does not register answers `-32601`; a legacy `tools/list` answers `-32602`. The sentence is defensible for a real legacy session, which opens with `initialize` and never gets past it, and the exact rule is stated at `:2540-2543`. Naming the method — `a legacy \`initialize\` falls off the modern seam as -32601` — would make the marginal note agree with the contract paragraph at no cost to the removability proof.

**F3. Not required. `/home/user/mcp-audit-wt/src/core/MCPClient.ts:705` spells "unpinned" as a comparison against one constant.**

`this.#pin !== MCP_MODERN_VERSION` is correct today only because `:675` has already removed every legacy pin from this path, leaving `undefined` and `MCP_MODERN_VERSION` as the reachable values. The guide's claim at `:2762-2763` — a modern pin takes no legacy fallback — is unconditional, and the code honors it for one revision. `this.#pin === undefined` is equivalent at this site today and states the fact the branch actually depends on.

### Referral to the objective lane

`/home/user/mcp-audit-wt/src/core/MCPServer.ts:96` inserts `isModernRequest` between `isMCPInputResult` and `isMCPPaginationParams` in an otherwise sorted named-import list. `format:check` and `lint:check` reported 0 on the final tree, so no instrument objects; whether the toolchain owns import ordering is mechanical conformance and I issue no verdict on it.

VERDICT: FAIL
