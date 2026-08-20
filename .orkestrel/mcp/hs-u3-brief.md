# HS-U3: the handshake matrix as gated regression proofs

## Role and engine

Opus 5 `implementer`, native, in `/home/user/mcp`, the sole writer in this checkout. This unit is
native because its proofs spawn real child processes and read their pipes, which a bench sandbox
cannot measure.

## Objective

Retain the handshake drive matrix as gated tests: the source-level spawned stdio control and the
packed-artifact matrix with its red control.

## Context

- Read before editing: the `AGENTS.md` file, `.claude/rules/tests.md`,
  `.claude/rules/workspace.md` (§ Test project matrix), the `tmp/handshake-reconciliation.md`
  file (binding; § Q5 fixes this unit's placement), and the evidence under
  `tmp/handshake-evidence/`.
- The tree is committed and clean at commit 240eac9, with HS-U1 (client: no probe cap, exact
  pins, construction refusal) and HS-U2 (server: the refusal split) landed. The examples and
  guide are NOT yet updated; a later unit owns them.
- Verified behavior on this tree, 2026-08-20: a bare `createMCPServer` answers a legacy
  `initialize` with `-32601 Method not found: initialize`; the
  `createStdioServer(createMCPLegacy(mcp))` composition completes `initialize` at both legacy
  revisions and `server/discover` at 2026-07-28; the unpinned client with `timeout: 15_000`
  negotiated `2026-07-28` over a cold spawn once the cap was deleted (the Orchestrator's
  10-round matrix, retained in `.orkestrel/probe/protocol-instrument/` in the probe repository,
  medians 2233-2297ms connect).
- The existing spawned-child stdio control lives in `tests/src/server/factories.test.ts` (near
  the region the reconciliation cites); the existing packed-artifact proof is
  `tests/distribution.test.ts`, whose project packs the package and installs it in a scratch
  consumer — that in-test pack and install is the proof's own mechanism and is permitted.

## The items

1. **The spawned stdio control** (`tests/src/server/factories.test.ts`, `src:server`): extend or
   adjust the existing spawned-child stdio coverage so it proves, over a real spawned child:
   - a bare `createMCPServer` behind `createStdioServer` answers a raw legacy `initialize` line
     with `-32601` naming `initialize`;
   - the `createMCPLegacy`-wrapped composition completes a legacy `initialize` and one
     `tools/call` end to end.
2. **The packed-artifact matrix** (`tests/distribution.test.ts`, `distribution`): against the
   installed packed artifact, one table-driven case per row, cold spawn each:
   - unpinned, no `timeout` → negotiates `2026-07-28`;
   - unpinned, `timeout: 15_000` → negotiates `2026-07-28`;
   - pinned `2026-07-28` with `timeout: 15_000` → negotiates exactly the pin;
   - pinned `2025-11-25` and pinned `2025-06-18` → each negotiates exactly the pin through
     `initialize`;
   - a runtime pin outside the supported set (crossed through an `unknown` boundary, never a
     rejected literal) → throws `MCPError` at construction, before any child spawns;
   - **the red control**: a client pinned to `2026-07-28` against a fixture peer that serves no
     modern seam — a minimal protocol-faithful scripted stdio peer that answers
     `server/discover` with a JSON-RPC error and would answer `initialize` normally — fails with
     the pin's refusal, and the assertion names the pin's failure, never a deadline. Run the
     failing case once yourself and pin the exact error the client actually throws.
   - No row asserts on elapsed time.
3. **Naming.** Every test is named for what it proves, never for a brief label or a matrix row
   id.

## Unknowns

- The exact error a pinned-modern client throws when the probe is refused by a legacy-only peer:
  measure it in this tree and pin what you measure; report the reading.
- Whether the distribution file's existing structure admits the matrix as one table or as
  sibling cases: your call, recorded.

## Scope

- Owned: `tests/src/server/factories.test.ts`, `tests/distribution.test.ts`.
- Off-limits: all `src/`, `guides/mcp.md`, `README.md`, `tests/src/core/**`,
  `tests/guides.test.ts`, `tmp/` except your own report file.
- Permission limits: no commit, no push, no dependency changes to this repository's own
  `package.json` or `node_modules` (the distribution test's scratch-consumer install is the
  proof and is permitted), no `git checkout`/`restore`/`stash`/`reset`/`clean`, no secrets.

## Execution

You perform this assignment directly and spawn no agent. The child processes your tests spawn
are the proofs, not agents.

## Deviation contract

A conflict with the reconciliation's Q5 placement or a behavior that contradicts the verified
facts in Context stops the unit with the standard report. Test table shape and fixture wording
are yours to decide and record.

## Output

Write your report to the `tmp/hs-u3-report.md` file: per item what changed with file:line, the
measured pinned-modern refusal, the red-control reading, the scoped run counts, then
`git diff --stat` and `git status --short`. No process diary.

## Acceptance criteria (in order)

1. `npm run lint:check` exits 0.
2. `npm run check` exits 0.
3. `npm run format:check` exits 0 (run `npm run format` first if needed).
4. `npx vitest run --config vite.config.ts --no-cache --project src:server tests/src/server/factories.test.ts`
   exits 0; paste the count lines.
5. `npx vitest run --config vite.config.ts --no-cache --project distribution` exits 0; paste the
   count lines. This packs and installs, so give it minutes rather than seconds before reading
   it as wedged.
6. The red control's failing case is demonstrated once with the assertion flipped or the fixture
   inverted (your choice), red at the pin's refusal, then restored green; record both readings.

## Review evidence

The actual `git diff --stat` and `git status --short` output in the report.
