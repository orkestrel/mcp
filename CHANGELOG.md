# Changelog

**This file does not ship.** `files` in `package.json` is `["dist/src", "README.md"]`, so
the tarball carries the built output, the README, the manifest, and the licence — nothing
else. The changelog lives in the repository beside the source it describes. Read it here or
on the repository page; it will not be in `node_modules`.

Versions match the package manifest. Dates are ISO.

## 0.0.12 — prepared for publication

The hardening campaign that made `2026-07-28` the canonical implementation and collapsed the
dated revisions onto it. Nothing below is a compatibility layer: this package is greenfield,
and every consumer of a changed contract is updated in the same change.

### Added

- **The modern `2026-07-28` surface as the one engine.** `MCPServer` dispatches typed
  JSON-RPC through `dispatch` and the string boundary through `handle`. It is
  host-independent and stateless across requests: every modern request carries its own
  protocol version, client identity, and capabilities, and state crosses requests only
  through an explicit handle.
- **Resources, Prompts, and completion, as consumer-supplied ports.**
  `MCPResourceManagerInterface`, `MCPPromptManagerInterface`, and
  `MCPCompletionManagerInterface` arrive through `MCPServerOptions.resources`,
  `.prompts`, and `.completion`. The host owns the registry; this package projects it to
  the wire and stores nothing. No dependency was added to build them. A manager that takes
  a concrete URI owns its own template matching, so this package expands no URI template
  and implements no RFC 6570 level.
- **Durable Tasks**, the draft extension: `tasks/get`, `tasks/update`, `tasks/cancel`,
  opted into through `MCPServerOptions.task` and advertised as the
  `io.modelcontextprotocol/tasks` capability. The store is injected; this package ships
  none, and no implicit poll loop. `MCPTaskClient` is the client half.
- **Subscriptions.** `subscriptions/listen` takes an event-driven producer through
  `MCPServerOptions.subscription` and returns a held-open stream. It is modern-only: it is
  a `2026-07-28` method, and a legacy-era client asking for it gets `-32601`.
- **Held-open answers with one cancellation owner.** `MCPStreamController` and
  `MCPTextStreamController` wrap every stream leaving `dispatch` and `handle`, so
  cancellation is arbitrated at one seam whatever produced the stream.
- **Request-scoped progress with backpressure.** `MCPProgressReporter` is a single-slot
  handoff between one producer and one serial consumer. Progress is not durable and not
  replayable, which is what keeps it distinct from Tasks.
- **Owned snapshots at the JSON boundary.** `snapshotJSON` and `snapshotToolResult` take
  ownership of a value crossing the wire boundary instead of trusting the caller not to
  mutate it afterwards.
- **`HTTPDisconnect`**, the Node HTTP response lifecycle composition the server transports
  build their disconnect handling on.

### Changed

- **Legacy is a removable decorator, not a second engine.** `MCPLegacy` (built by
  `createMCPLegacy`) translates the two dated revisions onto the modern dispatcher.
  `initialize`, `ping`, `tools/list`, and `tools/call` acquire modern request metadata,
  run through the same engine, and are projected back unstamped. `MCPServer` holds no era
  branch, imports no legacy module, and spells no legacy method or header name.
- **Removing legacy server ingress is eight published modules**, and the repository law
  suite computes that set from the tree and requires it to equal the recorded list in both
  directions. Client legacy egress is not in that set and does not go with it — see the
  guide's open question.
- **JSON-RPC batching is gone by deletion.** Only individual messages are accepted, and the
  types enforce it. `2025-03-26` and `2024-11-05` are no longer spoken, because the first
  requires batching and the second requires a two-endpoint transport this package never
  implemented.
- **`Origin` enforcement ships on by default** on the HTTP face. A request with no `Origin`
  passes; a canonical `localhost`, `[::1]`, or `127.0.0.0/8` literal origin passes; every
  other present origin must occur in `origin.origins`. The decision reads the `Origin`
  value alone, never the request URL or `Host`. A deployment validating origin upstream
  says so with `origin: { enabled: false }` rather than with an empty list.

### Behaviour a legacy client observes differently

All three follow from one cause: legacy now runs on the modern engine, so it inherits that
engine's validation instead of running beside it.

| A legacy `tools/call` whose …      | Answered before                                    | Answers now                                            |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| tool result contains `NaN`         | `null`, via `JSON.stringify`'s non-finite coercion | `-32603` — the produced result is not valid JSON       |
| `params.arguments` is `null`       | accepted, and the tool ran                         | `-32602` — arguments must be an object                 |
| tool value exceeds `limit.content` | `-32000`                                           | `-32603`, the same code a modern call already received |

`-32000` survives only where it carries a meaning no modern code does: a modern result the
dated revision has no shape for — a held-open stream, a `task`, an `input_required`, or a
capability refusal.

### Proven

- A real foreign protocol client drives the Streamable HTTP surface end to end:
  `@modelcontextprotocol/conformance@0.2.0-alpha.10` against revision `2026-07-28`,
  **23 passed / 0 failed**, the `dns-rebinding-protection` security guard included.
- A generated consumer resolves `@orkestrel/mcp`, `@orkestrel/mcp/browser`, and
  `@orkestrel/mcp/server` through the real `exports` map — ESM and CJS where both are
  declared, ESM only for `./browser` — and type-checks against the shipped declarations.
- The browser face is proven by Playwright driving real Chromium against a real Node
  server: a real `WebSocket`, a real `fetch`, and a real `MessageChannel`.

### Recorded limits

Stated here because a limit a consumer discovers on the wire is worse than one it reads
first. Full detail is in [`guides/src/mcp.md`](guides/src/mcp.md).

- **IDE integration is not claimed.** No IDE, editor, or agent host has driven this server.
  The conformance number is evidence about the wire and does not transfer to a host
  application.
- **No top-level `types` field.** Every `exports` subpath carries a `types` condition, so
  `node16`, `nodenext`, and `bundler` resolution find declarations. A consumer on legacy
  `moduleResolution: node` does not read `exports` and sees an untyped package.
- **A build-time version notice, three times.** API Extractor bundles TypeScript 5.9.3
  through a transitive pin while this project compiles with 6.0.3. The notice is
  informational: `build` exits 0 and every declaration is emitted.
- **Source maps ship** — five `.map` files, 1,130 kB of the 2.5 MB unpacked, about 45
  percent. Kept so a consumer debugging a protocol library steps into real source.
- **`id: null` on a legacy error response is excluded with evidence, not settled.** This
  package omits `id` when a malformed request makes it unreadable, and never emits `null`;
  that is correct for `2026-07-28`, which overrides JSON-RPC 2.0 §5. Whether the legacy era
  requires `null` could not be settled: the dated `schema/2025-06-18/schema.ts` is absent
  from this repository, from the installed modules, and from the local npm cache, and no
  network was available to fetch it. A legacy client receiving a malformed-request error
  therefore gets no correlation id at all. No code was changed on a guess.

### Not built, on purpose

Roots, Sampling, and Logging — all deprecated at `2026-07-28`, none with a registry or a
consumer here. A built-in resource or prompt store, because a default store is product
policy and these capabilities ship as mechanism. Tool-invocation rate limiting, because the
limit and the capacity both belong to the deployment; compose it in front as ordinary
`@orkestrel/server` middleware, exactly like auth.
