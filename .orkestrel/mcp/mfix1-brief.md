# MFIX1 — the transports release what they acquire

## Role and engine

`implementer`, Opus 5. Seven findings across six transport classes and one factory. The judgment load
is lifecycle shape and contract coherence. The auditor will be GPT-5.6 Sol, which held the objective
lane of the round that found these.

Read this before you start: **your own engine wrote both commits under audit.** The two lanes found
seven defects in them and in the code around them. Treat the surrounding classes as suspect rather
than as context you already understand.

## Objective

Close findings M1, M2, M3, M4, M9, M11, and M13 from `.orkestrel/mcp/mcp-audit-reconciliation.md`, so
every transport in this package releases what it acquires and no `close()` takes a resource it does
not own.

## What this closes toward

`@orkestrel/mcp` 0.0.20 sits in the middle of a release wave. `@orkestrel/probe` has never published,
depends on this package, and cannot publish until it does. Both audit lanes said they would not
publish this tip.

## Context

Read before acting, in this order:

1. `AGENTS.md`, in particular § Design laws.
2. `.claude/rules/typescript.md`, `.claude/rules/patterns.md`, `.claude/rules/tests.md`,
   `.claude/rules/quality.md`.
3. `.orkestrel/mcp/mcp-audit-reconciliation.md` — the findings and the rulings.
4. `.orkestrel/mcp/mcp-audit-sol-verdict.md` and `mcp-flow-evidence.md` — the objective lane's
   verdict and the Orchestrator's executed measurements.
5. `guides/mcp.md` for what is currently documented. **You do not edit it**; a sibling unit owns the
   guide repairs.

Host: Linux container, bash, network available. The tree is clean. `npm test` binds a port and takes
minutes.

## The measured rule, for M1

```
owns  = input.readableFlowing !== true              // recorded in start, before attaching anything
pause = owns && input.listenerCount('data') === 0   // tested in close, after removing our own
```

| Case at `start` | `readableFlowing` | owns | listeners left at close | pause |
| --- | --- | --- | --- | --- |
| fresh stdin | `null` | yes | 0 | yes |
| caller already paused it | `false` | yes | 0 | yes |
| caller already resumed it | `true` | no | — | no |
| a second reader attached after `start` | `null` | yes | 1 | no |

Both halves are load-bearing and answer different questions at the two moments where each is
answerable. Measured over all four cases in `.orkestrel/mcp/flow-fix-probe.mjs`; the shipped
`listenerCount`-at-start rule is wrong in three of the four, and a release-time listener check alone
is wrong in two.

`#ownsFlow` disappears or is renamed by this change, which closes M9: it is the package's only
compound private property, and it names a decision about the past rather than a state.

## The findings

**M2 — `WebSocketServerTransport` releases nothing.** `start()` attaches three listeners on
`this.#socket.emitter` as anonymous arrow expressions, so they cannot be removed by reference at all.
`close()` removes none of them, and `#receive` carries no closed guard, so a frame arriving between
`close()` resolving and the peer's close echo still emits `message` on a closed transport's emitter.
`StdioServerTransport`'s own class doc names this class as its mirror, and after `ec65d53` the two
have opposite lifecycle semantics.

Give it the same shape the stdio server now has: `readonly` bound handler fields, a `#release()` that
removes them, called from both close paths before the emit. Both `WebSocketClientTransport` classes —
`src/server/transports/` and `src/browser/transports/` — carry the same shape; fix all three.

**M3 — neither HTTP client transport cancels in flight.** `close()` aborts no pending `fetch` and
releases no response reader. The objective lane's executed probe drove a never-ending SSE response
and observed zero cancellations and a `send()` still unsettled after `close()` resolved. Track what is
in flight and abort it on close.

**M4 — `src/server/factories.ts:243` discards the unbind.** `bindServer(mcp, bridgeMessageTransport(transport))`
throws away the function that detaches the binder — verbatim the line `ec65d53` repaired at `:359`.
Capture it and call it from the `stop` handler before the transport close, and from the `close`
handler. `src/browser/helpers.ts` already applies this pattern correctly; read it rather than
inventing a second shape.

**M11 — a pending WebSocket upgrade cannot be cancelled.** `WebSocketClientTransport` retains no
reference to the in-flight upgrade request, so `close()` during connect cannot destroy it. Retain and
destroy it.

**M13 — `HTTPClientTransport.close()` is not idempotent**, on both faces: it re-emits `close` on every
call, unlike every other transport here. `MCPClientTransportInterface.close` does not currently
require idempotence, which is why the objective lane referred it rather than ruling it.

**The Orchestrator's ruling, which you implement rather than re-decide:** every transport's `close()`
is idempotent, and the contract says so. One transport behaving differently from five is a defect
whichever way the contract reads, and the five are right. Add the sentence to
`MCPClientTransportInterface.close` in `src/core/types.ts` and make the two HTTP clients match.

## Not yours

- **`guides/mcp.md`.** A sibling unit repairs its four false statements. Do not touch it. Where your
  change makes a guide sentence false, name the sentence in your report and leave it.
- **`HTTPDisconnect`, `browser/helpers.ts`, and the missing `test:distribution`.** Findings M8, M10,
  and M12, all owned by the sibling unit.
- **`MessagePortTransport`.** Ruled contained by the platform, retention only. Do not change it.
- **The `sendEventStream` universal.** Ruled correct. Do not narrow it.

## Scope

Owned files, the only files you may write:

- `src/server/transports/StdioServerTransport.ts`
- `src/server/transports/WebSocketServerTransport.ts`
- `src/server/transports/WebSocketClientTransport.ts`
- `src/server/transports/HTTPClientTransport.ts`
- `src/browser/transports/WebSocketClientTransport.ts`
- `src/browser/transports/HTTPClientTransport.ts`
- `src/server/factories.ts`
- `src/core/types.ts` — only the `close` contract sentence M13 names
- every test file mirroring the files above, under `tests/src/server/transports/`,
  `tests/src/browser/transports/`, and `tests/src/server/factories.test.ts`

Off-limits: every other file, and in particular `guides/`, `README.md`, all barrels,
`src/server/transports/HTTPDisconnect.ts`, `src/browser/helpers.ts`, `src/server/helpers.ts`,
`src/core/helpers.ts`, `package.json`, and `vite.config.ts`.

Tools: Read, Grep, Glob, Edit, Write, Bash. No commits, no pushes, no dependency installs, no
destructive command. Never run `git checkout`, `git restore`, `git stash`, `git reset`, or
`git clean`.

## Execution

Perform this assignment yourself. Spawn nothing.

## Where a probe may live

Write every executable probe as `tmp/probe/<name>.test.ts` and run it with `npm run test:probe`.
`vite.config.ts:236-237` includes `tmp/probe/**/*.test.ts` and the directory is git-ignored. Delete
every probe before you return; promote one into the mirrored suite when it proves something worth
keeping.

## Deviation contract

Stop and report — expected, found, exact evidence, done or not done, at most one hypothesis — when:

- a quoted line is not where this brief says it is;
- a fix needs a file this brief marks off-limits;
- making `close()` idempotent changes an observable behaviour some test depends on that this brief
  does not name.

Decide and carry on, recording the choice in your report: the field names, the exact contract
sentence, how in-flight work is tracked, and where each new test sits.

## Acceptance criteria

Run these in order and report each bare exit code.

1. `grep -rn "readableFlowing\|listenerCount\|isPaused" src/server/transports/StdioServerTransport.ts`
   — the start-time reading tests `readableFlowing`, and the close-time decision also tests
   `listenerCount('data')`.
2. `grep -rn "removeListener\|removeEventListener" src/server/transports/ src/browser/transports/` —
   every transport that attaches a listener removes it.
3. `npm run format` then `npm run format:check` exits 0.
4. `npm run lint:check` exits 0.
5. `npm run check` exits 0.
6. Each of M1, M2, M3, M4, M11, and M13 has at least one test that fails against the unfixed code.
   Record the exact command and its failing count before each fix, and the same command's passing
   count after.
7. `npx vitest run --config vite.config.ts --no-cache --reporter=dot --project src:server` exits 0.
8. `npx vitest run --config vite.config.ts --no-cache --reporter=dot --project src:browser` exits 0.
9. `npm run test:policy` exits 0.
10. `npm run test:guides` exits 0. Where a guide sentence this unit falsifies breaks it, stop and
    report rather than editing the guide.

Do not run `npm test`, `npm run build`, or `npm run test:conformance`. An independent verifier takes
those readings.

## Output

A report with one row per finding stating what changed and what proves it, the red-then-green command
and counts for criterion 6, one row per acceptance criterion with its bare exit code, the decisions
you took under the deviation contract, every guide sentence your change falsifies, and anything you
could not close.

No process diary.
