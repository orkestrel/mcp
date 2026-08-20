## Q1. Legacy reach

### Ruling

Keep legacy reach in the explicit `createMCPLegacy` decorator. Do not move it into `createMCPServer` or make transport factories add it automatically.

The three choices have distinct costs:

- Making `createMCPServer` answer `initialize` would put an era branch back inside the modern engine. Supporting the rest of the legacy method set would either absorb `MCPLegacy` entirely or leave two partial legacy implementations. Keeping the decorator afterward would make it a superfluous wrapper. Removing it would eliminate the documented modern-only composition and its removability proof.
- Making transport factories wrap automatically is not permitted by their current contract. They accept `MCPDispatcherInterface`, while `createMCPLegacy` needs the server identity available on `MCPServerInterface`. Automatic wrapping therefore requires narrowing every factory parameter, expanding the minimal dispatcher, adding transport options, or runtime recognition of already-wrapped values. It also leaves `bindServer` inconsistent and risks double decoration. Each outcome moves protocol policy into transport mechanism.
- Teaching the wrapper explicitly costs one import and one call at each deployment site. It preserves the current API, the narrow transport boundary, custom dispatchers, and the ability to deploy modern-only ingress intentionally.

The sibling examples are inconsistent today. The `createMCPRoutes` TSDoc correctly shows `createMCPLegacy(mcp)`, but the HTTP guide, WebSocket guide and TSDoc, stdio guide and TSDoc, session-middleware example, and README use a bare server. The WebSocket text even claims an `initialize` handshake, while the bare composition cannot answer it.

### Exact change

Keep these runtime defaults unchanged:

- `createMCPServer` remains modern-only.
- `createMCPLegacy` remains the sole legacy-ingress addition.
- `createMCPRoutes`, `createWebSocketServer`, `createStdioServer`, and `bindServer` remain transparent consumers of `MCPDispatcherInterface`.

Update these examples to import `createMCPLegacy` and pass `createMCPLegacy(mcp)` where the example claims a generally usable MCP endpoint:

- [src/server/factories.ts](/home/user/mcp/src/server/factories.ts:203), WebSocket example.
- [src/server/factories.ts](/home/user/mcp/src/server/factories.ts:369), stdio example.
- [src/server/middlewares.ts](/home/user/mcp/src/server/middlewares.ts:83), session example.
- [guides/mcp.md](/home/user/mcp/guides/mcp.md:1966), HTTP example.
- [guides/mcp.md](/home/user/mcp/guides/mcp.md:2184), WebSocket example.
- [guides/mcp.md](/home/user/mcp/guides/mcp.md:2278), stdio example.
- [guides/mcp.md](/home/user/mcp/guides/mcp.md:3016), session pattern.
- [README.md](/home/user/mcp/README.md:34), headline server example.

Keep one adjacent bare example explicitly labeled modern-only. Correct the WebSocket text from “initialize” to modern discovery, and make the stdio `client.version` comment say `2026-07-28` for an unpinned client.

### Preserves

This preserves optional legacy ingress, transport independence, custom dispatcher support, one shared execution engine, and the documented ability to remove the legacy layer.

### Forecloses

It forecloses examples that compile but reject the client handshake they claim to support, without making legacy support an irreversible default.

## Q2. Probe deadline

### Ruling

Discovery uses the ordinary client request deadline:

```text
discovery deadline = options.timeout ?? DEFAULT_MCP_REQUEST_TIMEOUT
```

`DEFAULT_MCP_PROBE_TIMEOUT = 50` does not survive.

The invariant is that an unpinned client negotiating with a responsive modern server selects the newest common revision on both a warm transport and a cold spawned transport, provided the discovery response arrives within the caller’s declared request deadline. Transport startup latency must not alter the negotiated era.

The fallback bound is:

- A legacy server that answers unknown `server/discover` with `-32601` triggers fallback immediately.
- A legacy server that remains silent triggers fallback when the configured request deadline expires.
- With no configured deadline, that bound is `DEFAULT_MCP_REQUEST_TIMEOUT`, currently 30 seconds.

A silent legacy peer and a slow modern peer are observationally identical until one replies or the deadline expires. No universal 50 ms rule can preserve modern negotiation on cold transports while also detecting silence correctly.

### Exact change

In [src/core/MCPClient.ts](/home/user/mcp/src/core/MCPClient.ts:205):

- Remove `#probe`.
- Remove the `DEFAULT_MCP_PROBE_TIMEOUT` import.
- Make `discover()` pass `this.#timeout` to `#request`.
- Remove all TSDoc claiming that an explicit timeout is capped for discovery.

In [src/core/constants.ts](/home/user/mcp/src/core/constants.ts:177):

- Delete `DEFAULT_MCP_PROBE_TIMEOUT`; do not retain an alias or compatibility shim.
- Keep `DEFAULT_MCP_REQUEST_TIMEOUT = 30_000`.

Update the `MCPClientOptions`, `MCPClientInterface`, factory TSDoc, constant surface table, method table, and contract clauses in [src/core/types.ts](/home/user/mcp/src/core/types.ts:2220) and [guides/mcp.md](/home/user/mcp/guides/mcp.md:2736).

### Preserves

This preserves a bounded discovery attempt, caller control through the existing `timeout` option, immediate fallback on an explicit legacy refusal, and the no-polling architecture.

### Forecloses

It forecloses configured timeouts becoming an undocumented 50 ms negotiation policy, late valid discovery responses being discarded, silent downgrade by transport temperature, and pinned-modern failures caused only by cold startup.

## Q3. Pin fidelity

### Ruling

A pin is an exact constraint. It is not a preference.

- `undefined` means negotiate.
- A supported `MCPVersion` means use exactly that revision or fail.
- Any other runtime value is invalid input and must fail synchronously during construction, before transport subscription or `start()`.
- Do not add a `strict` option or another boolean. Supplying `version` already expresses strictness; adding a switch would allow two facts to disagree.

Construction is the correct rejection point because validity depends only on local constants. Deferring it to `connect()` would perform transport side effects before reporting a programmer error.

Pinned behavior is:

- A pinned modern client sends discovery with that revision. It succeeds only if the validated discovery result advertises the same revision. It never selects another advertised revision and never falls back to legacy.
- A pinned legacy client sends `initialize` with that revision. It succeeds only if `protocolVersion` in the response equals the pin. A different supported legacy revision is still a pin violation. It sends no `notifications/initialized` after a mismatch.
- Every failed connection closes the connection it opened under the existing ownership rules.

The bogus-pin behavior cannot survive. Treating an unsupported string as unpinned contradicts the rule that absence is represented only by `undefined`.

### Exact change

At the start of the constructor in [src/core/MCPClient.ts](/home/user/mcp/src/core/MCPClient.ts:205):

- Read `options.version` once.
- If it is defined and `isMCPVersion` returns false, throw synchronously.
- Use the existing `MCPError` with `MCP_UNSUPPORTED_VERSION` and context containing `supported: SUPPORTED_PROTOCOL_VERSIONS` and `requested`.
- Perform this check before creating the emitter or subscribing to the transport.
- Update [src/core/errors.ts](/home/user/mcp/src/core/errors.ts:5) and the guide’s `MCPError` row to state that this error also represents locally detected protocol incompatibility, while timeouts and lifecycle faults remain ordinary `Error`s.

In `#negotiate`:

- When a modern pin exists, require `discovery.supportedVersions` to contain that exact pin.
- On absence, throw `MCPError` `MCP_UNSUPPORTED_VERSION` with `{ supported, requested }`.
- Select the pin itself rather than calling `inferVersion` for that branch.
- Keep `inferVersion` only for unpinned negotiation.

In `#initialize`:

- After validating that the response carries a supported legacy revision, compare it with the requested pin.
- On mismatch, throw `MCPError` `MCP_UNSUPPORTED_VERSION` with `{ requested, negotiated }`.
- Perform the comparison before writing `notifications/initialized` or installing connection state.

Update the `version` option documentation to say “exact pin” and document the synchronous construction failure.

### Preserves

This preserves the `MCPVersion` public type, all valid pinned calls, newest-common selection for unpinned clients, the existing retry for unpinned `-32022`, and connection cleanup.

### Forecloses

It forecloses invalid JavaScript input silently becoming negotiation, modern pins selecting legacy advertisements, and legacy pins accepting a server-selected replacement.

## Q4. Modern-only legacy refusal

### Ruling

A request without `MCP_META_VERSION` is structurally legacy. A bare modern dispatcher must answer a legacy-shaped request with:

```text
-32601 Method not found: <method>
```

It must not call the request’s absent modern metadata malformed.

### Exact change

In `MCPServer.#modern` at [src/core/MCPServer.ts](/home/user/mcp/src/core/MCPServer.ts:370):

- Check `isModernRequest(request)` before `parseRequestContext`.
- If false, return `buildJSONRPCError(id, JSONRPC_METHOD_NOT_FOUND, \`Method not found: ${request.method}\`)`.
- Continue to use `parseRequestContext` only after key presence has fixed the request as modern.

Update the contradictory bare-server description in [guides/mcp.md](/home/user/mcp/guides/mcp.md:2534).

### Preserves

This preserves:

- Silence for notifications.
- `-32602` when the modern version key is present but its value or companion metadata is malformed.
- `-32022` when a well-shaped modern request names an unsupported revision.
- `-32601` for an unregistered modern method.
- The optional `MCPLegacy` layer as the only component that actually answers legacy methods.

### Forecloses

It forecloses a legitimate legacy handshake being reported as malformed modern input and aligns the code with the guide’s existing claim that legacy traffic falls off a modern-only seam as `-32601`.

## Q5. Binding tests

| Proof | File | Vitest project |
|---|---|---|
| Configured discovery waits past 50 ms but before its declared deadline and remains modern; a genuinely silent peer falls back at that deadline | [tests/src/core/MCPClient.test.ts](/home/user/mcp/tests/src/core/MCPClient.test.ts:1032) | `src:core` |
| Invalid runtime pin throws synchronously before `start`; modern and legacy pins reject a different negotiated revision | [tests/src/core/MCPClient.test.ts](/home/user/mcp/tests/src/core/MCPClient.test.ts:588) | `src:core` |
| Bare `dispatch` and `handle` return `-32601` for legacy-shaped `initialize`; a present malformed modern key remains `-32602` | [tests/src/core/MCPServer.test.ts](/home/user/mcp/tests/src/core/MCPServer.test.ts:717) | `src:core` |
| The existing spawned-child stdio control expects `-32601` for its first bare legacy `initialize`; the wrapped composition still completes initialize and a tool call | [tests/src/server/factories.test.ts](/home/user/mcp/tests/src/server/factories.test.ts:680) | `src:server` |
| Updated flagship fences import and compose `createMCPLegacy`, and the claimed behavior is executed | [tests/guides.test.ts](/home/user/mcp/tests/guides.test.ts:550) | `guides` |
| The exact cold spawned drive matrix runs against an installed packed artifact: unpinned with and without timeout remains modern, both valid legacy pins remain exact, the modern pin remains exact, and an invalid runtime pin fails before spawning | [tests/distribution.test.ts](/home/user/mcp/tests/distribution.test.ts:130) | `distribution` |

Use `Reflect.apply(createMCPClient, undefined, [options])` for the invalid-pin unit proof so the test exercises the JavaScript runtime boundary without `any`, an assertion, or a suppression.

The registry 0.0.19 comparison is baseline evidence, not a permanent test. The packed current artifact is the regression subject. Do not place the pack/install matrix in `integration`; packaging belongs to `distribution`. Retain the existing source-level cross-environment checks in `integration`.

Remove the current source-text assertions for `#probe` and `Math.min`. They assert implementation syntax rather than observable behavior.

## Proposed unit decomposition

Use one serial writing unit with three independently checkable slices.

1. **Client negotiation contract**

   - Remove the probe cap and exported probe constant.
   - Validate runtime pins at construction.
   - Enforce exact modern and legacy pin results.
   - Update client/error contracts and core tests.
   - Acceptance: every configured modern response arriving before `timeout` negotiates modern; silent fallback remains bounded; invalid and mismatched pins never connect or downgrade.

2. **Server reach and examples**

   - Return `-32601` for legacy-shaped requests on a bare server.
   - Keep malformed modern metadata at `-32602`.
   - Correct the README, guide, transport-factory TSDoc, and session example compositions.
   - Acceptance: bare ingress is honestly modern-only; every example claiming both eras uses `createMCPLegacy`; transport signatures and defaults do not change.

3. **Public-artifact regression**

   - Update the server factory control.
   - Add the guide behavior proof.
   - Promote the cold spawned drive matrix to `distribution`.
   - Acceptance: the packed artifact passes the full version/timeout matrix, and each proof is discovered by its named project.

The unit closes only after the focused tests pass, guide parity reports no missing or phantom API, `DEFAULT_MCP_PROBE_TIMEOUT` has no source or guide occurrence, and the required gate chain is green.

LANE COMPLETE