# MCP-AUDIT2: audit the fixes Sol wrote, on the engine that did not write them

## Role and engine

Role `reviewer`. Engine Claude Opus 5, high effort. Read-only. You rule; you never edit, and you
never accept your own reasoning as evidence.

## Why you exist

`AGENTS.md` and `.agents/orchestration.md` require every nontrivial implementation to be audited by
at least one lane whose engine did not write it. GPT-5.6 Sol audited this package's earlier work,
then Sol wrote the fixes that closed its own findings. You are the only available auditor: Grok is
never a lane in this harness, and Sol cannot audit itself.

The gates are already green. Gate evidence is not the subject — a green suite proves the code does
what the tests say, not that the tests say the right thing.

## Objective

Rule on the numbered claims below and return per-claim verdicts with evidence. A claim you cannot
substantiate is a FAIL, not a courtesy PASS.

## Read first, in this order

1. `AGENTS.md` — § Design laws and § Writing especially
2. `.claude/rules/quality.md` — the Falsification law owns the method and the evidence each verdict
   carries
3. `.claude/rules/architecture.md`, `.claude/rules/patterns.md`, `.claude/rules/tests.md`,
   `.claude/rules/documentation.md`
4. `.agents/skills/orkestrel-falsify/SKILL.md` — it fixes the verdict shape, the value set, and the
   single terminal line. Follow it exactly.
5. `guides/mcp.md` — the governing spec

## Context

- The subject is `git diff 7b8d5ec..HEAD -- src/ tests/ guides/`, staged for convenience at
  `tmp/mcp-sol-work.diff`. The staged copy is a convenience, not the authority: run the diff yourself
  for anything you rule on, and read the working tree for current state.
- The tree is committed and clean at `bb30e34`. Untracked `tmp/` files are expected.
- Gates were taken on the host and all exit 0: `format:check`, `lint:check`, `check`, `build`,
  `test` (src 30 files / 1036 tests, policy 86, config 28, guides 132, conformance 4, integration 4),
  `test:distribution` 1, and `scaffold audit` reporting no drift across 131 planned paths. Do not
  re-run the suite; another agent may be using this host.
- Vendored files are off-limits as subjects: `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/`,
  `.codex/`, `.cursor/`, `configs/helpers.ts`, `scripts/*.sh`, `tests/config.test.ts`,
  `tests/policy.test.ts`, `tests/setupPolicy.ts`. Report a defect in one as a scaffold finding.
- `guides/*.md` other than `guides/mcp.md` and `guides/README.md` are refetched mirrors, out of scope.

## The claims

**Claim 1.** The `MessagePortTransport` repair releases everything it acquires and nothing it did
not. Rule on whether retaining the listeners as bound fields introduced any new retention, whether
`close()` is idempotent, and whether a caller who closes mid-message gets a coherent outcome.

**Claim 2.** The WebSocket close-before-open repair is correct in shape as well as behaviour. The
writer ruled that close-before-open **rejects** with a distinct message rather than resolving or
reusing the handshake failure. Rule on that ruling: is the distinction one a caller can act on, is
the error's shape consistent with how this package reports other failures, and does the rejection
leave the transport in a state a caller can inspect?

**Claim 3.** The writer reported that `src/server/transports/WebSocketClientTransport.ts` needed no
change because it already retains the in-flight request, destroys it in `close()`, and resolves the
pending handshake through the request error handler. **Verify that claim against the source.** An
audit lane probed only the browser mirror, so this is an unverified assertion by the engine whose
work it excuses.

**Claim 4.** The stdio pump bound is sound. `close()` resolves a transport-owned release promise
before awaiting the supervisor's bounded `destroy()`, and the pump races its pending read against
that release. Rule on whether the race can drop a message a caller was entitled to, whether the bound
can fire while the child is healthy, and whether the public contract truly did not move.

**Claim 5.** The legacy-ownership membership check now lives in a package-owned suite and computes
membership in both directions with a planted control. Rule on whether it actually computes from the
tree rather than from a list beside it, whether the planted control would fail for the right reason,
and whether the guide's sentence now matches what runs.

**Claim 6.** The parity claim was narrowed rather than the gate widened. Rule on whether the narrowed
sentence is now true of the gate, and whether narrowing lost a check a reader of this guide would
reasonably expect.

**Claim 7.** The distribution inventory check is not vacuous. Rule on whether it would fail on a real
unexpected file, whether its negative control plants something the allowlist genuinely does not
cover, and whether its cleanup can delete a path it did not create.

**Claim 8.** The stdin invariant's narrowing is honest rather than convenient. It now says flowing
versus non-flowing is preserved and a never-read stream is left non-flowing, called a Node limit.
Rule on whether that is a real platform limit or a design choice wearing one.

**Claim 9.** Every prose line this range added obeys `AGENTS.md` § Writing: no count of a growable
set, no list item named by position, no clause written to persuade, and the voice rules in
`.claude/rules/writing.md`. Quote every line that fails and name the rule it fails.

**Claim 10.** Nothing in this range narrows, weakens, or deletes a test's ability to fail. For every
test the range changed, rule whether it can still fail for the reason it exists.

## Unknowns

- Whether the pump race has a losing interleaving. I do not know and the writer's own test drives
  only the descendant-held-pipe case.
- Whether the `close()` paths are idempotent. No test I know of calls `close()` twice.

## Scope

Read-only. Own nothing. Edit nothing. Spawn nothing. Perform this assignment directly. Do not run
`git checkout`, `git restore`, `git stash`, `git reset`, or `git clean`.

State no count in anything you write, and never name a list item by its position.

## Output

The verdict shape `.agents/skills/orkestrel-falsify/SKILL.md` fixes, and nothing else. Per-claim
verdicts with evidence, findings numbered in one sequence, and the single terminal line the skill
specifies. No process diary.
