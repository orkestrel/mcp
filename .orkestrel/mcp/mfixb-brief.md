# MFIX-B: make the guide true, gate the packed inventory, and finish the count sweep

## Role and engine

Role `sol` implementer. Engine GPT-5.6 Sol, high effort, sandbox `workspace-write`, rooted at
`/workspace/mcp`. You are the sole writer in this checkout for the duration of this unit.

## Objective

Close the remaining findings from the objective audit of `@orkestrel/mcp`. Every one is either a
statement the code does not support, a gate that cannot see what it claims to see, or a count that
has already drifted.

## Read first, in this order

1. `AGENTS.md` — in full, and its `Writing` section especially
2. `.claude/rules/documentation.md`, `.claude/rules/writing.md`, `.claude/rules/tests.md`
3. `guides/mcp.md` — the governing spec
4. `.orkestrel/mcp/mcp-audit-verdict.md` — the verdict this unit closes

## The findings

**F3 — the stdio client transport's release is unobservable, and the proposed remedy does not exist.**

The audit proposed re-pinning to a release of `@orkestrel/process` that closes inherited-pipe
iteration. **There is no such release.** `@orkestrel/process` 0.0.4 documents the opposite as
intended behaviour: `destroy` resolving does not mean the child's streams have closed, and a
descendant that inherited the child's stdio holds those pipes open after the child exits, so `exit`
and `lines` can both stay outstanding. Its guide's own remedy is a `timeout`.

So this is a documented limit, not a re-pin. Rule on which of these the transport takes, and say why:

- give the pump a bound so a descendant holding an inherited pipe cannot keep `close()` pending
  forever; or
- state the limit in `guides/mcp.md` where a caller configuring a stdio child will read it.

Prefer the bound if the transport can carry one without changing its public contract. If you take
the limit instead, the guide must name the observable symptom — a `close()` that does not settle —
and the caller's remedy, not merely the mechanism.

**F4 — the stdin restoration invariant is stated more strongly than Node can honour.**

The executed matrix produced `null → false`, `false → false`, and `true → true`, while restoring
caller-owned listener counts in every case. Node exposes no public operation that restores
`readableFlowing === null` after data consumption starts, so no code change closes this.

Narrow the documented invariant to what holds: the transport preserves flowing versus non-flowing
state, and it restores every caller-owned listener. State plainly that a stream never read before
the transport started is left non-flowing rather than untouched, and that this is a Node limit
rather than a choice. Correct `guides/mcp.md` and any TSDoc that overstates it. The existing tests
already accept `null → false`; leave them accepting it, and make sure a comment there names the
reason rather than reading as an oversight.

**F6 — the distribution gate cannot see an unexpected shipped file.**

`tests/distribution.test.ts` installs and inspects the packed artifact, checks missing export
targets, compares runtime keys with declaration names, and pins declaration names. It never inspects
the packed file inventory against the manifest allowlist, so a file the manifest does not intend can
ship undetected. It also reports a target's absence without separating a manifest defect from a
build-output defect.

Read the `files` list from `npm pack --json` and compare it with the paths the manifest allows.
Add a negative control that plants a file the allowlist does not cover and proves the check fails on
it — plant it under a path this unit created, and name in your report exactly how you removed it.

**Your sandbox denies both halves of the reading.** `npm pack` failed `EROFS` under
`/root/.npm/_cacache/tmp` for the audit lane, and this suite installs a tarball, which is a nested
install the sandbox denies. Write the check and its control, then report the run as an observation
naming the exact command. The Orchestrator takes the authoritative reading on the host. Do not weaken
the check to something your sandbox can run.

**F7 — counts survive in test comments.**

The audit's scoped sweep found prohibited prose including "ships six transports", "Seven findings
across six transport classes and one factory", "false in eight places", "17 rows", "The third
answer", "the second assertion", and "first expectation". Its control search for `twentieth`
returned no match.

Sweep `tests/` and `src/` yourself, case-insensitively and across inflections including spelled-out
numbers and ordinals, and replace every count of a set this package can extend and every reference
to a list item by its position. Name the pattern and the paths behind your result, including a clean
one. An external identifier is not a count: an RFC section number, a JSON-RPC error code, a protocol
revision date, a version, a limit, a duration, and a size all stay. Do not touch `.orkestrel/`; those
are campaign artifacts that prune at acceptance.

**F8 and F9 — the guide claims executions that do not happen.**

F8: the guide says the parity gate resolves every backticked API name. `tests/guides.test.ts` checks
Surface rows in both directions and named imports in TypeScript fences, and contains no general
inline-code-span parity check. Narrow the sentence to the checks the suite performs, or add the scan.
Rule and say which you took.

F9: beyond the already-known false statement at `guides/mcp.md:1594`, the Tests and Contract sections
separately claim the policy suite checks legacy-removability and `MCPServer` absence.
`rg -n -i 'legacy|MCPLegacy|MCPServer' tests/policy.test.ts` returns no match, and
`tests/policy.test.ts` is a vendored file that cannot carry a package-specific rule.

For every one of these, choose: remove the claim, or make it true in a **package-owned** suite.
`tests/guides.test.ts` is package-owned and is the natural home for a membership rule the guide
states. Do not add package-specific behaviour to `tests/policy.test.ts`.

Where the guide says a membership rule "is executed instead of asserted", making it true is worth
more than removing it — that sentence is the guide's own argument for why the rule can be trusted.

## Scope

- **Owned:** `guides/mcp.md`, `tests/distribution.test.ts`, `tests/guides.test.ts`, every test file
  under `tests/src/`, `tests/setup*.ts`, `tests/fixtures/`, `README.md`, and the TSDoc inside
  `src/**/*.ts`. You may change source code only where F3's bound requires it.
- **Off-limits:** every other file. The vendored host — `AGENTS.md`, `CLAUDE.md`, `.agents/`,
  `.claude/`, `.codex/`, `.cursor/`, `configs/helpers.ts`, `scripts/*.sh`, `tests/config.test.ts`,
  `tests/policy.test.ts`, `tests/setupPolicy.ts` — is owned by `@orkestrel/scaffold` and restored by
  `repair`. `package.json` and `vite.config.ts` are scaffold-planned; do not hand-edit either. Do not
  change the version. Do not touch `.orkestrel/`.

## Host conditions

- The tree is committed and clean at `235e515`. Untracked `tmp/` files are expected.
- **Your sandbox denies a loopback listener.** `listen EPERM` on `0.0.0.0` and `127.0.0.1` was
  measured in this repository by the unit before you, so the `src:browser` and `src:server` projects
  cannot collect inside your sandbox at all. Do not try to make them pass. Report them as
  observations naming the exact command; the Orchestrator takes those readings on the host.
- Your sandbox also denies a nested install and a process one level below a child you spawn.
- The `src:core` project needs no listener and does run.
- The network is unavailable. Do not install or fetch.
- Do not run `npm run build`, tree-wide `npm run format`, or the whole `npm test`.

## Execution

Perform this assignment directly. Spawn nothing.

## Prohibitions

- Never run `git checkout`, `git restore`, `git stash`, `git reset`, or `git clean`. Each discards a
  working-tree change silently, and this tree has no other copy of your work. To undo your own edit,
  undo exactly that edit.
- Never commit, push, install, or read a credential.
- No `any`, no `as`, no `!`, no `@ts-ignore`, no `@ts-expect-error`, no `eslint-disable`.
- No mocks, behavioral fakes, module replacement, or framework spies.
- State no count in any prose you write, and never name a list item by its position. You are closing
  the finding that says so.

## Acceptance criteria

Close them in this order and report each command with its exit code and counts. Put an observation
you cannot close under **Observations**, never under a criterion.

1. `rg -n -i 'six transports|seven findings|eight places|17 rows|the third answer|the second assertion|first expectation' tests/ src/ guides/ README.md`
   returns no hit.
2. `rg -n -i 'legacy' tests/policy.test.ts` returns no hit, **and** every guide sentence that claimed
   the policy suite checks a package-specific rule either names a package-owned suite that performs
   the check or no longer makes the claim.
3. `npm run lint:check` exits 0.
4. `npm run check` exits 0.
5. `npx vitest run --config vite.config.ts --project src:core` exits 0. Report its counts.
6. `npx vitest run --config vite.config.ts --project guides` exits 0. Report its counts.

## Deviation contract

Stop and report if the objective itself conflicts with what you find: expected, found, exact
evidence, done or not done, and at most one short hypothesis. An ancillary choice — a helper's name,
where a guide paragraph sits — is yours to decide, record, and carry on from.

## Output

Write your report to `tmp/codex/mfixb-report.md` and make it your final message too. It contains: the
files you touched and what changed in each; your ruling on F3 and F8 with the reason; each acceptance
criterion with its exit code and counts; an **Observations** section holding every reading your
sandbox denied, each with the exact command that takes it on a host; the exact plant-and-remove steps
for F6's negative control; and anything you could not close. No process diary.
