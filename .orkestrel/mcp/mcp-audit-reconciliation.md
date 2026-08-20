# MCP-AUDIT — reconciliation

Two lanes, one brief, blind, clean contexts. Sol held the objective lane with `workspace-write` and
executed probes. An Opus reviewer held the subjective lane, read-only, and was told its own engine
wrote both commits under audit.

Sol: **FAIL** — 2 confirmed, 9 broken, 0 unresolved, no findings outside the claims.
Opus: **FAIL** — 3 confirmed, 7 broken, 1 unresolved, 4 findings outside the claims.

The Orchestrator reproduced every finding it carries. Two needed executed probes the read-only lane
could not run; those are in `mcp-flow-evidence.md` with their instruments.

## Where the lanes converge

Both lanes independently reached the same diagnosis on the ownership rule, and Sol reached the same
remedy the Orchestrator's probe did: record the pre-start flow state, and pause only when this
transport started a non-flowing input **and** no caller reader remains. Two lanes and one measurement
agreeing on a two-part rule is the strongest signal this round produced.

## Where they disagree, and who is right

**Claim 6, the WebSocket server transport.** Opus ruled it a remaining door; Sol ruled that it
"delegates established-socket teardown to the bounded wrapper". Both observed correctly and asked
different questions. Sol asked whether the process can still exit — it can, because the wrapper's
timer is unref'd. Opus asked whether a closed transport stays subscribed — it does.

Reproduced by the Orchestrator. `WebSocketServerTransport.start()` attaches three listeners on
`this.#socket.emitter` as anonymous arrow expressions, so they cannot be removed by reference at all.
`close()` sets `#closed`, calls `this.#socket.close()`, and emits `close` — it removes nothing. And
`#receive` carries no `#closed` guard, so an inbound frame arriving between `close()` resolving and
the peer's close echo still emits `message` on a closed transport's emitter.

That is the exact shape `ec65d53` removed from `StdioServerTransport`, in the class that class's own
doc names as its mirror. **Opus is right, and the fix is structural**: the handlers must become
`readonly` bound fields before they can be removed, which is what the stdio class already does.

**Claim 3.** Sol ruled the universal too broad because `sendEventStream` calls `sse.end()` on a
supplied stream. Sol also ruled that call correct. No defect; the claim's wording was wrong, not the
code. Dropped on the record.

## Findings carried

| # | Finding | Lane | Reproduced |
| - | ------- | ---- | ---------- |
| M1 | `#ownsFlow` records "nobody was listening" and spends it as "nobody was reading". A caller's `resume()`, or an attach-then-detach, leaves the stream flowing with zero listeners, so the transport pauses a flow it never started. | Both + probe | Yes — `readableFlowing=true listeners=0` |
| M2 | `WebSocketServerTransport.close()` releases none of the three listeners `start()` attached, and `#receive` has no closed guard, so a frame arriving after close still emits `message`. The handlers are anonymous arrows and cannot be removed by reference. | Opus | Yes |
| M3 | Neither HTTP client transport aborts an in-flight `fetch` or response reader on `close()`. | Sol | Sol's executed SSE probe: zero cancellations, `send()` unsettled after `close()` resolved |
| M4 | `src/server/factories.ts:243` discards the unbind — verbatim the line `ec65d53` repaired at `:359`. | Opus | Yes |
| M5 | The unbind repair has no binding instrument. With only `unbind()` removed, the added factory test still passes. | Both | Sol measured: 1 passed, 36 skipped |
| M6 | Four false statements in `guides/mcp.md`: a provided `env` **replaces** `process.env` (it merges over it, `mergeEnvironment` with no `isolated`); child stderr **inherits** the parent (`Process` pipes it and retains a bounded tail); the transport calls `node:child_process.spawn` (it constructs `Process`); and transport close "ends the connection and releases resources" (M3 disproves it). | Both | Yes |
| M7 | The commit message asserts that `stop()` ordering the unbind before the close matters. Reversing the two lines produces no observable difference through any seam this package exposes. | Both | Yes |
| M8 | `HTTPDisconnect.bridge()` called twice overwrites `#timer` — the first ref'd interval runs for the process's life — and the first bridge's `#release()` aborts the lifecycle, so the second bridge's abort listener registers against an already-aborted signal and is never added. | Opus F1 | Yes |
| M9 | `#ownsFlow` is the only compound private property in the package, and it names a decision about the past rather than a state. It dissolves under M1's fix. | Opus F2 | Yes |
| M10 | `createScopeMessageListener`'s `seen` set is never pruned; `serveMCPScope`'s disposer clears `teardowns` and not `seen`, so a long-lived Service Worker retains every port it ever accepted. | Opus F4 | Yes |
| M11 | `WebSocketClientTransport` retains no reference with which to destroy a pending upgrade request, so a `close()` during connect cannot cancel it. | Sol | Yes |
| M12 | This package defines no `test:distribution`, while `@orkestrel/process` and `@orkestrel/probe` each pack, install outside the repository, and compare each entry's runtime export set against its declarations. | Both | Yes |
| M13 | `HTTPClientTransport.close()` re-emits `close` on every call, unlike every other transport here. | Opus referral | Yes |

## The artifact is currently correct

Sol packed and installed the tarball outside the repository: 18 files, ESM loading 140 core, 19
browser, and 44 server exports, CJS loading 140 and 44, every runtime export set equal to its `.d.ts`
value declarations, and an added outside-population export made the parity control fail. **M12 is a
missing gate rather than a live defect.** Adding it is still owed, because the next change has
nothing watching it.

## Ruled, not repaired

- **Claim 3's universal.** Narrowed by Sol to caller-owned injected stdio streams. No defect.
- **`MessagePortTransport.close()`** closes an injected port without removing its two listeners.
  Opus bounded it as contained by the platform, retention only. Recorded, not carried.

## The measured rule both halves need

```
owns  = input.readableFlowing !== true              // recorded at start, before attaching
pause = owns && input.listenerCount('data') === 0   // tested at release, after removing our own
```

Correct in all four cases the Orchestrator measured. A listener count alone answers "is anyone
reading now" and never answers "was this already flowing before I touched it"; `isPaused()` collapses
`null` and `true` into one answer. The subjective lane's own proposed remedy — the release-time
listener check alone — still pauses a stream the caller had resumed.

**The same defect and the same rule appeared in `@orkestrel/probe` in the same session**, where a
sibling unit wrote `#flowing = !process.stdin.isPaused()`. There it made four signal tests time out
at 120 seconds. One measured rule closes both packages.

## Carried

M1 through M13 are carried by two fix units. M1, M2, M3, M4, M9, M11, and M13 go to MFIX1, the
transport and factory half. M5, M6, M8, M10, and M12 go to MFIX2. M7 is closed by MFIX1's own commit
message stating the honest property. Nothing is dropped.
