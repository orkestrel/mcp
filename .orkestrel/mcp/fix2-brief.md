# mcp fix unit 2 — the audit round's findings

## Role and engine

Sol `implementer`, GPT-5.6 Sol, inside `codex exec --sandbox workspace-write` at `/home/user/mcp`.

## Objective

Close every finding the fix-unit audit left open, per the `tmp/fix-audit-verdict.md` file and the
rulings it records.

## Context

- Read before editing: the `AGENTS.md` file, `.claude/rules/writing.md`, `.claude/rules/tests.md`,
  `.claude/rules/documentation.md`, the `tmp/fix-audit-verdict.md` file, and the guide sections
  you touch. The tree is committed and clean at b59b80d.
- Standing sandbox conditions as before: no network, no loopback listener; a scoped run that needs
  one records the exact command for the host.
- The items:
  - **The `e.g.` sweep** — the term survives unruled in authored TSDoc at src/core/types.ts:46,
    :1659, :2188; src/browser/types.ts:61, :85, :139; src/browser/factories.ts:62;
    src/browser/transports/HTTPClientTransport.ts:37; src/server/types.ts:281, :283, :341, :363;
    src/server/factories.ts:127, :284; src/server/helpers.ts:396;
    src/server/transports/HTTPClientTransport.ts:34. Rule each by sense and replace with
    `for example` or recast the parenthetical. Sweep `i\.e\.` the same way. Re-run with patterns
    that can match a period-terminated term — no trailing `\b` on those branches — and report the
    pattern beside the paths, with the coverage stated truthfully and no count of the kept hits.
  - **F1** — tests/src/browser/factories.test.ts:134-138: the title and comment state the removed
    unconditional echo. Retitle to what the test proves (the client's default `protocols` offer is
    the token the server selects) and rewrite the comment to the selection rule.
  - **F2** — delete the count in "the five `.map` files" at README.md:111 and "the five maps" in
    the guide's twin sentence; the measured byte figures and the date stay.
  - **F3** — delete the `ROADMAP.md` file and move its deferred `MCPClientTransportInterface`
    rename row into the guide's declared-gaps prose, where the parity gate reaches it.
  - **The dead changelog link** — README.md:77 links `CHANGELOG.md`, which the repository does not
    hold. Delete the sentence; the fleet keeps no changelog and git history is the record.
  - **R1** — tests/guides.test.ts's README link gate filters external links, and after the rewrite
    every README link is external, so the assertion's population is empty. Recast the gate over
    the full link set: assert the set is non-empty and every member either resolves as a
    repository-relative path or is an absolute URL; the gate must fail on an empty population.
  - **R2** — add one executed transcription to tests/guides.test.ts pinning the repaired fence
    class: drive the guide's bare-then-stamped `tools/list` pair (guides/mcp.md:215 and its
    stamped control) through a real in-process server and assert the -32602 refusal and the
    stamped success the prose claims. Name the test for what it proves. Add one declared-gaps
    sentence to the guide recording that the remaining corrected fences are prose-checked, not
    executed.

## Unknowns

- Whether the R2 transcription can run in this sandbox (it is in-process, no listener) is likely
  yes; record the run either way.

## Scope

- Owned: `src/` (the named TSDoc lines), `tests/src/browser/factories.test.ts` (the named title
  and comment), `tests/guides.test.ts`, `guides/mcp.md`, `README.md`, `ROADMAP.md` (delete).
- Off-limits: everything else; `tmp/` except your own report file.
- Permission limits: no commit, no push, no install, no `git checkout`/`restore`/`stash`/`reset`/
  `clean`, no secrets.

## Execution

You perform this assignment directly and spawn no agent.

## Output

Write your report to the `tmp/fix2-report.md` file: per item, what changed with file:line, the
sweep patterns with their true coverage and per-hit rulings, the R1 and R2 red-then-green readings
(or the sandbox observation), and any claim of your own you flag. End with the diffstat. No
process diary.

## Deviation contract

A conflict with an item's prescription stops the unit with the standard report. An ancillary
choice (sentence form, test naming for what it proves) is yours to decide and record.

## Acceptance criteria (in order)

1. `npm run lint:check` exits 0.
2. `npm run check` exits 0.
3. `npm run format:check` exits 0 (run `npm run format` first if needed).
4. A sweep of `e\.g\.|i\.e\.` (no trailing boundary) over src/, guides/mcp.md, and README.md
   returns no authored-prose hit; every kept hit carries its ruling.
5. `ROADMAP.md` does not exist and the guide carries the deferred-rename row.
6. `rg -n "CHANGELOG" README.md` returns no hit.
7. The R1 gate fails on an empty population (state how you proved it) and passes on the tree.
8. The R2 transcription runs red against a deliberately unstamped control (state the run) and
   green on the tree, or its sandbox denial is recorded.

## Review evidence

Return the actual `git diff --stat` and `git status --short` output in the report. The full diff
stays in the tree for the auditor.
