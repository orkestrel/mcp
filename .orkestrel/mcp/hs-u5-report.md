# HS-U5 report

## Item 1: the worker bootstrap's era label

- `src/browser/helpers.ts:169-171` — appended to `serveMCPScope`'s `@remarks`: the served endpoint
  is modern-only, it answers a legacy `initialize` with `-32601`, and a dual-era worker composes
  `bindServer(createMCPLegacy(mcp), …)` instead.
- `src/browser/helpers.ts:214-216` — added a `@remarks` block to `serveMCP` stating the same fact.
- `guides/mcp.md:2436-2437` — appended the modern-only fact to both the `serveMCP` and
  `serveMCPScope` surface-row sentences.
- `guides/mcp.md:3292-3297` — qualified the drop-in prose: the registry `serveMCP` serves is
  modern only, answers every modern client, and a legacy `initialize` falls off as `-32601`; named
  the `bindServer(createMCPLegacy(mcp), …)` composition for a dual-era worker.
- `guides/mcp.md:3311` (was `:3310`, shifted by the preceding edit) — the trust-boundary sentence
  now reads "exposes the ENTIRE `tools` registry to every MODERN client".

## Item 2: the `MCPError` surface row

- `guides/mcp.md:1671` — replaced with the prescribed sentence naming a Model Context Protocol
  error preserving its numeric `code` and optional `context` — a remote JSON-RPC `error.data`, or
  the locally detected incompatibility's own detail. Column padding follows `oxfmt`'s Markdown
  table reflow.

## Item 3: the marginal note's method

- `guides/mcp.md:1558` — the code-comment sentence `a legacy request falls off the modern seam as
  -32601` now reads `a legacy \`initialize\` falls off the modern seam as -32601`, matching the
  brief's literal text (the backticks are literal characters inside the `ts` fence's comment, as
  specified).

## Item 4: the packed row's honest name

- `tests/distribution.test.ts:202` — renamed the `HANDSHAKE` row label from `'unpinned with a 15s
  deadline'` to `'unpinned with a configured deadline'`. No other site in the tree referenced the
  old label (`rg` for the exact string returned no matches after the edit).
- `tests/distribution.test.ts:190-194` — added to the `HANDSHAKE` block comment: the pin branches
  a conforming peer cannot exercise — the lying-peer legacy mismatch, the discovery-omitting
  modern pin, and the applied probe deadline — are bound red-then-green by the client proofs in
  `tests/src/core/MCPClient.test.ts`, so this matrix's subject is end-to-end negotiation of the
  installed artifact.

## Unknowns resolved

- `npm run test:guides` (136 tests, 1 file) passed with no sentence-mirroring failure, so no
  further guide mirror needed updating.

## Acceptance criteria

1. `npm run lint:check` — exit 0, no findings.
2. `npm run check` — exit 0 (root `tsc`, `check:src:core`, `check:src:browser`,
   `check:src:server` all clean).
3. `npm run format` (to converge table padding), then `npm run format:check` — exit 0:
   `All matched files use the correct format. Finished in 3673ms on 201 files using 4 threads.`
4. `npm run test:guides` — exit 0:
   ```
   Test Files  1 passed (1)
        Tests  136 passed (136)
   ```
5. `npx vitest run --config vite.config.ts --no-cache --project distribution` — exit 0:
   ```
   Test Files  1 passed (1)
        Tests  2 passed (2)
   ```

## Review evidence

```
$ git diff --stat
 guides/mcp.md              | 38 ++++++++++++++++++++------------------
 src/browser/helpers.ts     |  8 +++++++-
 tests/distribution.test.ts |  7 ++++++-
 3 files changed, 33 insertions(+), 20 deletions(-)

$ git status --short
 M guides/mcp.md
 M src/browser/helpers.ts
 M tests/distribution.test.ts
```

No deviation. All owned-file edits landed; scope stayed within `src/browser/helpers.ts` (TSDoc
only), `guides/mcp.md`, and `tests/distribution.test.ts`.
