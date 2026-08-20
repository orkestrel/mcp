# Handshake wave audit: falsify the wave end to end

## Roles and engines

The subjective lane is the Opus 5 `reviewer`, native, and its subjects are the Sol-written units
(HS-U1, HS-U2). The objective lane is the Sol `analyst`, `codex exec --sandbox read-only`, and
its subjects are the Opus-written units (HS-U3, HS-U4), the Orchestrator's recorded micro-edits,
and the wave-level claims. Each lane runs blind to the other in the pinned worktree
`/home/user/mcp-audit-wt` at the commit `b404a84` (the HS-U4 landing; the staged copy of this
brief carries the real hash). In a fix round the auditor was chosen as the engine that did not
write each subject.

## Objective

Attempt to refute each claim assigned to your lane. Return per-claim verdicts with evidence and
one terminal VERDICT line.

## Context

- The wave diff is `tmp/hs-wave-diff.patch` (26024f5..b404a84). The per-unit briefs, reports,
  the design lanes, the reconciliation, and the research records ride in `.orkestrel/mcp/`. The
  reports are subjects, not authority.
- Read before ruling: `AGENTS.md`, `.claude/rules/typescript.md`, `.claude/rules/names.md`,
  `.claude/rules/tests.md`, `.claude/rules/documentation.md`, `.claude/rules/writing.md`, and
  the `guides/mcp.md` guide.
- Gate evidence the Orchestrator took on the final tree, 2026-08-20: `format:check`,
  `lint:check`, `check`, `build` all 0; `test:src:core` 725 passed; `test:src:server` 264
  passed; `test:guides` 136 passed; the `distribution` project 2 passed. The Opus lane runs no
  mutating command; the Sol lane's sandbox is read-only.

## Claims, one shared sequence

Sol `analyst` lane, claims 1 through 5:

1. Each packed-matrix row in `tests/distribution.test.ts` fails for the defect it names: a
   negotiated-revision drift, a construction throw that arrives after a spawn, or a red control
   that fails for a deadline rather than the pin would each redden exactly its row. Rule from
   the assertions, and name any row a wrong implementation could pass.
2. The spawned stdio control and its WebSocket sibling in `tests/src/server/factories.test.ts`
   fail on the pre-split vocabulary and pass only on the split's answers.
3. HS-U4's composition sweep is complete: no example claiming a generally usable endpoint
   remains bare outside the labeled modern-only contrast and the ruled signature citation
   (`guides/mcp.md`, the contract clause naming the `createWebSocketServer` signature), and the
   executed flagship fence's control genuinely discriminates (the bare dispatcher refuses what
   the composed server answers).
4. The Orchestrator's micro-edits state only what the landed code makes true: the guide's
   probe-deadline sentence and deleted constant row (HS-U1 landing), the bare-server refusal
   paragraph and its transcription (HS-U2 landing), the duplex-control expectation
   (HS-U3 landing), and the handlers example comment (HS-U4 integration). Attack each against
   the code.
5. Wave-level closure: no spelling of `DEFAULT_MCP_PROBE_TIMEOUT` survives anywhere in the
   tree; the pre-split absent-declaration refusal message survives nowhere except the kept
   malformed-grammar sites (`src/core/MCPServer.ts`, `src/server/handlers.ts`, and their
   tests); and each exit-criterion capability in `.orkestrel/mcp/handshake-reconciliation.md`
   ends implemented and gated.

Opus `reviewer` lane, claims 6 through 8:

6. The pin contract's shape holds the design laws: construction refusal for an invalid runtime
   pin, exact-pin on both eras with no fallback from a pinned modern client, no added boolean or
   sentinel, absence meaning negotiate — and the `MCPError` context shapes agree with what the
   guide states.
7. The refusal split's vocabulary is honest at every answer it gives, coherent with the guide's
   bare-server paragraph, and `MCPServer.ts` carries no legacy spelling.
8. The TSDoc and contract prose the Sol units touched keep the writing canon: third-person
   first sentences, no banned vocabulary, claims a reader can check.

## Execution

You perform your lane's audit directly and spawn nothing. Attempt refutation, not confirmation.
CONFIRMED carries the evidence and the failed attack; BROKEN carries the exact evidence and the
smallest correct fix; UNRESOLVED carries what would decide it.

## Output

Per-claim verdict blocks for your lane's claims, then exactly one terminal line `VERDICT: PASS`
or `VERDICT: FAIL`. No process diary.
