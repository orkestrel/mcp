# HS-U4: examples, guide, README, and the executed fence

## Role and engine

Opus 5 `implementer`, native, in `/home/user/mcp`, the sole writer in this checkout.
Documentation-voice and example-shape work, the routing table's Opus class.

## Objective

Make every server-ingress example teach the era reach it claims, and make the guide state the
handshake contract the landed units enforce, with the flagship fence executed.

## Context

- Read before editing: the `AGENTS.md` file, `.claude/rules/documentation.md`,
  `.claude/rules/writing.md`, `.claude/rules/tests.md`, the `tmp/handshake-reconciliation.md`
  file (binding; § Q1 and the exit criterion are this unit's rulings), and the research records
  `tmp/handshake-research-servers.md` and the client-adoption research in
  `.orkestrel/mcp/`.
- The tree is committed and clean at dispatch, with HS-U1 (client), HS-U2 (server refusal
  split), HS-U3 (matrix proofs), and the Orchestrator's micro-edits landed. The micro-edits
  already removed the guide's `DEFAULT_MCP_PROBE_TIMEOUT` table row and cap clause, and already
  rewrote the bare-server refusal paragraph (near `guides/mcp.md:2536`) to the split — do not
  restate either; extend around them.
- Verified example sites carrying a bare server where the composition claims a generally usable
  endpoint (the union of both design lanes' lists, re-locate each by pattern):
  `src/server/factories.ts` (the `createStdioServer` and `createWebSocketServer` examples),
  `src/server/middlewares.ts` (the session example), `src/browser/factories.ts` (the
  `bindServer` example), `guides/mcp.md` (the HTTP, WebSocket, stdio, and session sections), and
  `README.md` (the headline server example). The `createMCPRoutes` example already composes the
  wrapper.
- The WebSocket prose claims an `initialize` handshake that the bare composition cannot answer;
  it corrects to modern discovery.

## The items

1. **The examples.** At every listed site, compose `createMCPLegacy(mcp)` with one identical
   trailing comment naming `initialize` and the modern-only subtraction, in the shape the
   reconciliation fixes: `// answers \`initialize\` too; pass \`mcp\` alone for modern-only`.
   Keep one adjacent bare example explicitly labeled modern-only where the guide's legacy
   section already teaches the contrast. Add the `createMCPLegacy` import wherever the fence
   needs it.
2. **The guide's handshake contract.** State, each in the section that owns it:
   - the pin contract: `version` is an exact pin, an unsupported runtime value throws from
     construction, and a supported pin the peer cannot serve fails `connect` naming what the
     peer offered;
   - that an unpinned `connect` can land on a legacy revision when the peer serves no modern
     seam, and pinning is how a caller refuses that; there is no separate downgrade signal —
     `version` carries the fact;
   - the worst case with the cap removed, grounded in the retained research: a reference legacy
     peer answers an unknown `server/discover` with a JSON-RPC error (the TypeScript reference
     server `-32601`, the Python reference server `-32602`), so the fallback normally costs one
     round trip; a peer that accepts the probe and never answers costs the configured deadline
     before the fallback, which carries its own.
   - the WebSocket prose correction to modern discovery.
3. **The executed fence.** In `tests/guides.test.ts`, transcribe and execute the flagship
   `createStdioServer` fence: the composed server answers a legacy `initialize`. Follow the
   file's existing transcription shape.
4. **Parity.** `guides/README.md` and any surface table the edits touch stay aligned; every
   backticked name resolves.

## Unknowns

- Whether a guide section already states part of item 2 in different words: converge to one
  home per fact, and record which sentences you replaced rather than added.

## Scope

- Owned: `src/server/factories.ts`, `src/server/middlewares.ts`, `src/browser/factories.ts`,
  `guides/mcp.md`, `README.md`, `tests/guides.test.ts`.
- Off-limits: `src/core/**`, `tests/src/**`, `tests/distribution.test.ts`, `tmp/` except your
  own report file. TSDoc example edits in the owned `src/server` and `src/browser` files are in
  scope; their executable code is not.
- Permission limits: no commit, no push, no install, no `git checkout`/`restore`/`stash`/
  `reset`/`clean`, no secrets.

## Execution

You perform this assignment directly and spawn no agent.

## Deviation contract

A conflict with a reconciliation ruling stops the unit with the standard report. Sentence form,
section placement, and which of two candidate homes carries a fact are yours to decide and
record.

## Output

Write your report to the `tmp/hs-u4-report.md` file: per item what changed with file:line, the
per-site example list as changed, the replaced-versus-added sentence record, then
`git diff --stat` and `git status --short`. No process diary.

## Acceptance criteria (in order)

1. `npm run lint:check` exits 0.
2. `npm run check` exits 0.
3. `npm run format:check` exits 0 (run `npm run format` first if needed).
4. `rg -n "createStdioServer\(mcp\)|createWebSocketServer\(mcp" src/ guides/ README.md` shows no
   bare composition outside an explicitly modern-only-labeled example.
5. `npm run test:guides` exits 0; paste the count lines.
6. `npm run build` exits 0 (the TSDoc example edits ride into declarations).

## Review evidence

The actual `git diff --stat` and `git status --short` output in the report.
