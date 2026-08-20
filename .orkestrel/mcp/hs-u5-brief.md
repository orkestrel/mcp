# HS-U5: the wave audit's carriers

## Role and engine

`builder`, Claude Sonnet, native in `/home/user/mcp`, the sole writer in this checkout. The unit
is fully specified; every item adopts an auditor's prescription.

## Objective

Close the wave audit's carriers: the worker bootstrap's modern-only label, the `MCPError`
surface row, the packed-matrix row's honest name, and the marginal note's method name.

## Context

- Read before editing: the `AGENTS.md` file, `.claude/rules/documentation.md`,
  `.claude/rules/writing.md`, and the `tmp/hs-wave-audit-verdict.md` file (the rulings —
  binding).
- The tree is committed and clean at commit a42d34f. Verified sites, 2026-08-20:
  `serveMCPScope` at `src/browser/helpers.ts:179` and `serveMCP` at `:211`; the guide's
  drop-in sentence at `guides/mcp.md:3292` and the every-client sentence near `:3310`; the
  surface rows at `guides/mcp.md:2436-2437`; the `MCPError` row at `guides/mcp.md:1671`; the
  modern-only marginal note at `guides/mcp.md:1558`; the packed row label
  `'unpinned with a 15s deadline'` at `tests/distribution.test.ts:202`.

## The items

1. **The worker bootstrap's era label.** `serveMCPScope` constructs a bare `MCPServer` with no
   legacy seam. State that on every surface a consumer reads:
   - one `@remarks` sentence on each of `serveMCP` and `serveMCPScope` in
     `src/browser/helpers.ts`: the served endpoint is modern-only — it answers a legacy
     `initialize` with `-32601` — and a dual-era worker composes
     `bindServer(createMCPLegacy(mcp), …)` instead;
   - the same fact appended to each surface row at `guides/mcp.md:2436-2437`, in each row's own
     sentence shape;
   - the drop-in prose at `guides/mcp.md:3292` and the every-client sentence near `:3310`
     qualified the same way: the registry serves every modern client, and a dual-era worker
     takes the `bindServer(createMCPLegacy(mcp), …)` composition.
2. **The `MCPError` surface row.** Replace the row at `guides/mcp.md:1671` with exactly:
   `| \`MCPError\` | class | A Model Context Protocol error preserving its numeric \`code\` and
   optional \`context\` — a remote JSON-RPC \`error.data\`, or the locally detected
   incompatibility's own detail. |` (one line, the table's own column padding).
3. **The marginal note's method.** At `guides/mcp.md:1558`, replace `a legacy request falls off
   the modern seam as -32601` with `a legacy \`initialize\` falls off the modern seam as
   -32601`.
4. **The packed row's honest name.** At `tests/distribution.test.ts:202`, rename the label
   `'unpinned with a 15s deadline'` to `'unpinned with a configured deadline'`, and add one
   comment above the row table stating that the pin branches a conforming peer cannot exercise —
   the lying-peer legacy mismatch, the discovery-omitting modern pin, and the applied probe
   deadline — are bound red-then-green by the client proofs in
   `tests/src/core/MCPClient.test.ts`, so this matrix's subject is end-to-end negotiation of the
   installed artifact.

## Unknowns

- Whether the guide mirrors the surface-row sentences elsewhere: if `test:guides` reddens on a
  changed sentence, update the mirroring line and record it.

## Scope

- Owned: `src/browser/helpers.ts` (TSDoc only), `guides/mcp.md`, `tests/distribution.test.ts`.
- Off-limits: everything else; `tmp/` except your own report file.
- Permission limits: no commit, no push, no install, no `git checkout`/`restore`/`stash`/
  `reset`/`clean`, no secrets.

## Execution

You perform this assignment directly and spawn no agent.

## Deviation contract

A conflict with a ruling stops the unit with the standard report. Sentence wrap and row padding
are yours to decide and record.

## Output

Write your report to the `tmp/hs-u5-report.md` file: per item what changed with file:line, then
`git diff --stat` and `git status --short`. No process diary.

## Acceptance criteria (in order)

1. `npm run lint:check` exits 0.
2. `npm run check` exits 0.
3. `npm run format:check` exits 0 (run `npm run format` first if needed).
4. `npm run test:guides` exits 0; paste the count lines.
5. `npx vitest run --config vite.config.ts --no-cache --project distribution` exits 0; paste the
   count lines (it packs and installs — give it minutes).

## Review evidence

The actual `git diff --stat` and `git status --short` output in the report.
