# MFIX1 — report

Unit: `implementer`, Opus 5. Brief: `mfix1-brief.md`. Findings M1, M2, M3, M4, M9, M11, M13.

| Finding | Change | Red then green |
| ------- | ------ | -------------- |
| M1, M9 | `StdioServerTransport` records `#flowing` at `start` from `readableFlowing === true` before attaching, and pauses in `#release` only when `!#flowing && listenerCount('data') === 0` after removing its own handler. `#ownsFlow` is gone. | 3 failed, 14 passed → 17 passed |
| M2 | `WebSocketServerTransport` gains `readonly #frame`, `#ending`, `#failure` bound fields and a `#release()` called from both close paths. | 3 failed, 9 passed → 12 passed |
| M3, M13 | Both HTTP clients track `readonly #pending = new Set<AbortController>()`, one per `send`, composed with `timeout` through `AbortSignal.any`; `close()` aborts and clears. `send` splits into `#exchange` so the controller covers the body read. `close()` guards on `#closed`, and `start()` clears it. | Node 2 failed, 18 passed → 20 passed; browser 4 failed, 1 passed → 5 passed |
| M4 | `factories.ts` holds `Map<WebSocketServerTransport, () => void>`; `stop` unbinds then closes, and the transport's `close` handler unbinds after leaving the map. | **no reddening instrument** |
| M11 | The Node `WebSocketClientTransport` retains `#request: ClientRequest \| undefined` and destroys it in `close()`. The ECONNRESET that follows resolves the suspended `start()`, matching the class's rule that a close during connect wins. | 2 failed, 12 passed → 15 passed |

Two new browser transport test files; that face previously had coverage only through
`tests/src/browser/factories.test.ts`.

## The proofs are real peers, not stubs

M3's Node face drives a real `node:http` server streaming an SSE body it never ends: the parked
`send` settles after `close()` and the server records the request abandoned. M11's peer holds the
handshake for 400 ms: `start()` settles within 120 ms of `close()` and the peer's socket count reaches
zero.

The browser face uses a boundary stub supplied through the transport's public `fetch` option — a real
`Response` over a real `ReadableStream` that honors `init.signal` — because a page cannot bind a
loopback server and the browser fixture server is not owned. The unit named that rather than passing
it off as a real endpoint.

## The contract sentence, added to `MCPClientTransportInterface.close`

`close` is idempotent: a call on a transport an earlier `close` already ended resolves without
emitting `close` again and without releasing anything twice. Idempotence bounds one closed lifetime
rather than the object — a transport that reopens on `start` arms itself there, and its next `close`
ends that connection and emits once for it.

The second half is load-bearing: all four client transports reopen on `start`, so a lifetime-scoped
flag is what keeps idempotence and reuse compatible.

## `NodeJS.ReadableStream` does not carry `readableFlowing`

That is the declared type of both the constructor parameter and `StdioServerOptions.input`, and both
are off-limits. The read is `this.#input instanceof Readable && this.#input.readableFlowing === true`,
so a duck-typed stream reads as not-flowing, which is the same answer an untouched one gives. No
assertion, no `any`, no change to an off-limits type.

## M4 has no binding instrument, and that is now established three ways

The unit removed **both** `unbind()` calls and re-ran the whole `src:server` project: 12 files, 257
passed, nothing reddens. The objective lane found the same by removing one call, and again by
attacking the ordering claim. The repair is implemented as ruled and the test the unit added passes
before and after.

The hypothesis, stated once and not investigated further: the binder's disposer and the teardown its
`closed` handler already runs converge on the same effects — `active = false`, abort every live
request, clear the map — and its one extra effect, replacing the bridge's slots with no-ops, has no
observer, because the bridge object the factory builds is reachable from nothing outside the closure.

That is the same class as M5 and M7, and it is a design question rather than another repair attempt.
**Carried to a successor.**

## Guide sentences this change falsifies, named and left

`guides/mcp.md:4056-4057` — a signal is now passed even with no `timeout`, and with one it is
`AbortSignal.any([close, AbortSignal.timeout(timeout)])`. `:4113-4114` — a request error caused by
this transport's own `close()` now resolves `start()` rather than rejecting it. `:4118-4119` —
`close()` also destroys a pending upgrade and unsubscribes from the socket. `:2785` — the `close` row
no longer states the whole contract, and its "release resources" clause is now true for the HTTP
transports, which repairs part of M6 in code rather than in prose.

## Two patches the Orchestrator applied

The unit returned exact patches for two off-limits files and the Orchestrator applied them:
`src/server/types.ts` and `src/browser/types.ts` carried TSDoc saying each `fetch` call is issued with
`signal: AbortSignal.timeout(timeout)`, which the change makes false both ways.

The lint failure was also the Orchestrator's — an unused parameter in a campaign instrument copied
into `.orkestrel/`. Fixed at the source.

## Gate evidence

`verifier`, Sonnet: `format:check`, `lint:check`, `check`, `build`, `test`, and `scaffold audit` all
exit 0. `scaffold audit` reports 0 of 131 planned paths drifted. `test:src` 30 files, 1029 tests;
`test:policy` 86; `test:config` 28; `test:guides` 125; `test:conformance` 4; `test:integration` 4.
No flake, no re-run.
