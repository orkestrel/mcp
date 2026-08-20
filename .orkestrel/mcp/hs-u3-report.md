# HS-U3 report — the handshake matrix as gated regression proofs

Both items landed, and the baseline was already red in both owned files: the committed tree at
240eac9 carried two `src:server` failures and one `distribution` failure that HS-U1 and HS-U2
caused and did not carry. Each is repaired inside this unit's owned files and named below.

## Item 1 — the spawned stdio control

`tests/src/server/factories.test.ts`

- `tests/src/server/factories.test.ts:713-716` — the spawned child's `bare` branch asserts the raw
  legacy `initialize` line is refused `-32601` **and** that the refusal message is exactly
  `Method not found: initialize`. It asserted `-32602` before, which is the vocabulary the Q4
  ruling replaced.
- `tests/src/server/factories.test.ts:738-741` — the same child's second stage asserts the message
  as well as the code, so a `-32601` naming some other method no longer satisfies it.
- `tests/src/server/factories.test.ts:798` — the control is renamed for what it proves:
  `CONTROL — a bare server refuses initialize at either shape, naming the method, over a spawned
  child`, with a comment stating why `initialize` is absent from the modern registry.
- `tests/src/server/factories.test.ts:789` — the `createMCPLegacy`-wrapped composition row is
  unchanged and already proves the second half of item 1 over the same spawned child: the child
  requires `result.protocolVersion === '2025-06-18'`, sends `notifications/initialized`, then
  requires the `tools/call` reply's content to read `5`, and the test asserts the child's exit code
  is 0.

### The sibling the same ruling turned false

`tests/src/server/factories.test.ts:452-482` — the WebSocket control asserted the same replaced
`-32602` and was red on the committed baseline. It is repaired to `-32601` with
`Method not found: initialize` at both request shapes and renamed for what it proves. It is in this
unit's owned file and acceptance criterion 4 cannot close while it is red, so it is repaired here
rather than reported. No other file is touched for it.

## Item 2 — the packed-artifact matrix

`tests/distribution.test.ts`

- `tests/distribution.test.ts:332` — `buildPackedConsumer` extracts the pack, install,
  EPERM-fallback extraction, and dependency provisioning out of the existing proof, so the matrix
  reuses one sequence instead of copying it. The existing test's assertions are unchanged apart
  from calling it.
- `tests/distribution.test.ts:50, 68, 114, 128` — the peer, the red control's scripted peer, the
  spawn marker, and the driver, written into the consumer at run time and run from there.
- `tests/distribution.test.ts:193` — the negotiating rows, each carrying the revision it lands on
  **and** the methods the client writes to reach it. The method list is the discriminator: a
  revision alone does not say which era produced it.
- `tests/distribution.test.ts:622` — the proof:
  `negotiates every supported revision from the installed artifact and refuses what a pin excludes`.
- `tests/distribution.test.ts:471` — the core face's pinned declaration count moves from 140 to
  139. HS-U1 deleted `DEFAULT_MCP_PROBE_TIMEOUT`, `dist/src/core/index.d.ts` no longer declares it
  (`grep -c DEFAULT_MCP_PROBE_TIMEOUT dist/src/core/index.d.ts` → 0), and the assertion's own
  comment obliges the count to move in the commit that moves the surface. That commit was one
  earlier, and the pin is in this unit's owned file.

Rows, all measured on 2026-08-20 against the tarball built from this tree, one cold-spawned child
each, no row asserting on elapsed time:

| Row | Reading |
| --- | --- |
| unpinned, no `timeout` | `2026-07-28`, wrote `server/discover` |
| unpinned, `timeout: 15_000` | `2026-07-28`, wrote `server/discover` |
| pinned `2026-07-28`, `timeout: 15_000` | `2026-07-28`, wrote `server/discover` |
| pinned `2025-11-25` | `2025-11-25`, wrote `initialize`, `notifications/initialized` |
| pinned `2025-06-18` | `2025-06-18`, wrote `initialize`, `notifications/initialized` |
| unpinned against the scripted legacy-only peer | `2025-11-25`, wrote `server/discover`, `initialize`, `notifications/initialized` |
| pinned `2020-01-01` | threw at construction, `-32022 Unsupported protocol version`, wrote nothing |
| red control: pinned `2026-07-28` against the scripted legacy-only peer | threw at connect, `-32601 Method not found: server/discover`, wrote `server/discover` and nothing else |

## The measured pinned-modern refusal

A client pinned to `2026-07-28` against a peer that refuses `server/discover` throws
`MCPError('Method not found: server/discover', -32601)` from `connect()`. It is the peer's own
refusal of the probe, surfaced unwrapped, and the recorded outbound methods are `['server/discover']`
alone — the client never attempted `initialize`. That absent second write is what makes this the
pin's refusal rather than the peer's: the same peer answers the unpinned row in the table, where the
client falls back to `initialize` and negotiates `2025-11-25`. The pin is the only difference
between the two rows, so the rival reading that the fixture peer is simply unreachable is excluded.

The assertion names that message and code and never a deadline. The row supplies
`timeout: 15_000`, so a client that waited its deadline out instead would report
`MCP request 'server/discover' timed out after 15000ms`, and that is exactly the string the red
demonstration below asserted.

## The construction refusal, measured rather than claimed

The refused pin arrives as parsed JSON (`rows.json` → `JSON.parse` → spread into the client
options), so it crosses an `unknown` boundary and is never a literal the compiler would refuse
first. Its peer is `marker.mjs`, whose only statement writes `spawned.txt`. The reading is
`phase: 'construct'`, `-32022`, no methods written, and `spawned.txt` absent
(`tests/distribution.test.ts:682`).

The marker control was proved able to fire before its absence was trusted: run alone,
`node marker.mjs` writes `spawned.txt` (32 bytes, `the refused pin spawned a child`). Driving the
same row with a supported pin instead is not a usable demonstration — the marker child exits the
moment it has written, `connect()` never settles, and the driver dies on an unsettled top-level
await before it reports anything. That reading is recorded here rather than encoded as a row.

## Criterion 6 — the red control demonstrated failing

Assertion flipped, `tests/distribution.test.ts:688`, to the deadline reading the row must never
produce:

```text
AssertionError: expected 'Method not found: server/discover' to be 'MCP request \'server/discover\' timed…'
Expected: "MCP request 'server/discover' timed out after 15000ms"
Received: "Method not found: server/discover"
 Test Files  1 failed (1)
      Tests  1 failed | 1 skipped (2)
```

Restored, same command:

```text
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

The whole matrix was also read before it was pinned: a throwaway `expect(readings).toBe('MEASURE')`
printed every row's actual reading, and each expectation in the table is the value that run
reported. The probe was removed; the table is what remains.

## Scoped run counts

Baseline, commit 240eac9, both commands read before any edit:

```text
npx vitest run --config vite.config.ts --no-cache --project src:server tests/src/server/factories.test.ts
      Tests  2 failed | 39 passed (41)
   × CONTROL — a bare server answers modern-shaped initialize with -32601 over a real socket
   × CONTROL — a bare server answers modern-shaped initialize with -32601 over a spawned child

npx vitest run --config vite.config.ts --no-cache --project distribution
      Tests  1 failed (1)
   expected 140, received 139 at tests/distribution.test.ts:260
```

Final tree, same commands:

```text
npx vitest run --config vite.config.ts --no-cache --project src:server tests/src/server/factories.test.ts
 Test Files  1 passed (1)
      Tests  41 passed (41)
   Duration  1.65s

npx vitest run --config vite.config.ts --no-cache --project distribution
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  15.64s
```

Gates, final tree, exit codes read bare:

```text
npm run format:check → 0
npm run lint:check   → 0
npm run check        → 0
```

## Decisions recorded

- **The matrix is a second `it`, not an extension of the packaging proof.** A failing handshake row
  must not read as a packaging failure, and the two claims are independent. The pack and install
  they share is extracted into `buildPackedConsumer` rather than copied, so the matrix costs one
  more pack and install and no second copy of that sequence to keep honest. Measured cost: the
  `distribution` project goes from 4.6s to 15.6s wall clock on this host, 2026-08-20.
- **The row table lives in the test file.** `.claude/rules/tests.md` places a case matrix in a
  setup file, and no setup file is in this unit's scope. The file already carries `FACES` and
  `NPM_REQUIRED_FILES` at module scope for the same reason, and the table follows that precedent.
  Moving it to `tests/setupServer.ts` is a successor decision for whoever owns that file.
- **The outbound methods are recorded through a proxy over the real transport**, not through a
  cooperating peer, so the red control's scripted peer and the packed peer are measured the same
  way and neither has to report on itself.
- **`expect(value, label)` is refused by this repository's Oxlint configuration**
  (`vitest(valid-expect): Expect takes at most 1 argument`), so each negotiating row is compared as
  one whole reading. The failure diff then names the row instead of reporting a bare revision
  string against another.

## Deviation state

No deviation. The behavior every item met matches the brief's Context: a bare `createMCPServer`
answers a legacy `initialize` with `-32601 Method not found: initialize`, the
`createMCPLegacy` composition completes `initialize` at both legacy revisions, and the unpinned
client negotiates `2026-07-28` over a cold spawn with and without a `timeout`. Q5's placement is
followed exactly: the spawned control in `tests/src/server/factories.test.ts` under `src:server`,
the packed matrix in `tests/distribution.test.ts` under `distribution`.

Two red baseline rows were repaired inside the owned files rather than reported as blockers,
because acceptance criteria 4 and 5 cannot close while they are red and both are edits to files
this unit owns. Both are named earlier in this report.

## Review evidence

```text
$ git diff --stat
 tests/distribution.test.ts         | 421 +++++++++++++++++++++++++++++++------
 tests/src/server/factories.test.ts |  30 ++-
 2 files changed, 382 insertions(+), 69 deletions(-)

$ git status --short
 M tests/distribution.test.ts
 M tests/src/server/factories.test.ts
```
