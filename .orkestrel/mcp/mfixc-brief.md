# MFIX-C: close the cross-engine audit, starting with the gate that cannot run

## Role and engine

Role `sol` implementer. Engine GPT-5.6 Sol, high effort, sandbox `workspace-write`, rooted at
`/workspace/mcp`. You are the sole writer in this checkout for the duration of this unit.

## Objective

An Opus 5 lane audited the fixes Sol wrote here and returned FAIL. Close its findings. One of them
stops `npm publish` outright.

## Read first, in this order

1. `AGENTS.md` — § Design laws and § Writing especially
2. `.claude/rules/quality.md` — its Instruments section decides two of these findings
3. `.claude/rules/writing.md`, `.claude/rules/tests.md`, `.claude/rules/documentation.md`
4. `guides/mcp.md` — the governing spec
5. `.orkestrel/mcp/mcp-audit2-brief.md` — the claims that produced these findings

## A1 — the distribution gate cannot run on a clean checkout, and it gates publication

`tests/distribution.test.ts` mints its negative-control directory with
`mkdtempSync(join(root, 'tmp', 'mcp-distribution-control-'))`. `tmp` is gitignored and nothing under
it is tracked, so a fresh clone has no `tmp/` directory and `mkdtemp` throws `ENOENT`. The call sits
**outside** the `try`, so the scratch directory minted the line before it leaks with no cleanup.

`test:distribution --mode release` is the last step of `prepublishOnly`. **This blocks the release.**

Reproduced by the Orchestrator on this tree:

```text
$ mv tmp /tmp/holdout && npm run test:distribution
Error: ENOENT: no such file or directory, mkdtemp '/workspace/mcp/tmp/mcp-distribution-control-XXXXXX'
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

The gate passed earlier only because campaign work happened to have created `tmp/`.

The auditor's remedy closes this and A2 together: mint the control directory at the package root
instead — `mkdtempSync(join(root, 'mcp-distribution-control-'))` — which needs no pre-existing
directory. Move its creation inside the `try`, or into a `finally` that removes whichever directories
exist.

Prove it: remove `tmp/` entirely, run the gate, and record the reading. Restore `tmp/` afterwards —
it holds this unit's own brief and journal.

## A2 — the negative control has an uncontrolled rival reading

The planted file lives under a gitignored path, so its absence from the tarball is equally explained
by "outside the manifest `files` allowlist" and by "gitignored". `.claude/rules/quality.md`
§ Instruments requires naming the rival reading an instrument must exclude and showing it reports
differently.

Moving the control to the package root excludes it by `files: ["dist/src", "README.md"]` alone. State
that in the test's own comment, so the next reader knows which rule the absence proves.

## A3 — the two transport faces settle the same interleaving oppositely

`start()` then `close()` before the socket opens **rejects** on the browser face and **resolves** on
the Node face. `guides/mcp.md` sells the pair as the same API shape with a different host underneath,
"so a consumer swaps `@orkestrel/mcp/server` for `@orkestrel/mcp/browser` with no call-site change".
A consumer who makes that swap and did not `await start()` moves from a resolved promise to an
unhandled rejection. A caller cannot act on a distinction that inverts with the import specifier.

**Ruled: both faces RESOLVE.** Reasons, so you can check the ruling rather than obey it: the Node
face's resolve is already documented as deliberate and is proven by a test that bare-`await`s the
pending `start()`; a caller who called `close()` themselves does not need an exception to learn what
they just did; and `close` is emitted **before** the settlement on both faces, so a listener observes
the closure regardless.

On the browser face, capture and call the resolver where it currently rejects. Do not change the Node
face.

Then document it, because the audit found it documented nowhere: the browser class doc's `close()`
bullet, and the guide clause that lists what `close()` does. State that closing before the socket
opens settles the pending `start()` rather than leaving it pending, and that both faces agree.

If you conclude the ruling is wrong, stop and report with your reasoning rather than implementing the
other direction.

## A4 — the legacy-ownership instrument has a blind spot its own guide denies

`LEGACY_OWNER_PATTERN` in `tests/guides.test.ts` recognises an importing participant only through the
specifier `'./MCPLegacy.js'` or `'./MCPSession.js'`. A module containing
`import { MCPLegacy } from '@src/core'` — this repository's own cross-directory idiom, used in the
stdio client transport — matches no branch. The membership check stays green while the guide's module
list goes wrong, which directly falsifies the guide's own sentence that an added participant and a
stale entry fail the same way.

The guide also misstates the blind spot: it says the checks cannot reach participation that never
spells the entity name. The defeating vector spells it.

The planted control is drawn from **inside** the covered population — the exact `./MCPLegacy.js` form
the pattern was written for — so it certifies one branch and says nothing about the class the
instrument cannot reach. `.claude/rules/quality.md` § Instruments requires a control drawn from
outside the covered population, and requires the membership rule stated first.

Drop the specifier constraint so any `\bMCPLegacy\b` or `\bMCPSession\b` binding counts however the
module reaches it — the word boundary already excludes `MCPLegacyResult`. Add a control drawn from
outside the covered population: a module importing the entity through `@src/core`, which the current
pattern misses and the corrected one must catch. Prove the corrected pattern fails on that control
and the old one did not.

Then reconcile the guide: either derive the suite's list from the guide's own list so editing one
alone fails, or narrow the guide's sentence to say the executed list lives in the suite. Say which
you took.

## A5 — the close sequence is stated backwards in two places, and the guide contradicts itself

The stdio client transport's class doc and one guide clause both order it "terminates the child,
releases the line pump, tears the supervisor down". The code releases the pump **first**, then makes
one bounded `destroy()` call that terminates and tears down. The same range states it correctly
elsewhere in the guide, so the guide disagrees with itself.

The order is the whole mechanism: a release stated after the await it exists to precede describes code
that would hang. Restate both to match the code.

## A6 — the stdin narrowing states the difference but not the consequence

The guide and the class doc say a never-read stream is left non-flowing at `false`. What makes `false`
differ from `null` is the consequence: a stream at `false` does **not** resume when a `data` listener
is attached later. So a caller who injects a never-read stream, stops the server, and then attaches
their own listener receives nothing until they call `resume()`.

The surrounding paragraph promises the injected streams remain the caller's, and this is the one way
the transport measurably changes a stream it hands back. Add the consequence and the remedy wherever
the `false` state is stated. Verify the behaviour before you write it.

## A7 — two prose lines

- The guide's sentence about the descendant and the transport close writes `close` as a bare word
  read as a compound noun. `.claude/rules/writing.md` § Code tokens requires a backticked token
  followed by a noun: the transport's `close` call.
- The sentence before it uses `it` where both the client and the transport are named, so the pronoun
  can attach to either. Name the noun.

## Scope

- **Owned:** `tests/distribution.test.ts`, `tests/guides.test.ts`, `guides/mcp.md`,
  `src/browser/transports/WebSocketClientTransport.ts`,
  `tests/src/browser/transports/WebSocketClientTransport.test.ts`,
  `src/server/transports/StdioClientTransport.ts` for its class doc only, and
  `src/server/transports/StdioServerTransport.ts` for its class doc only.

  *Amended: a first run stopped here, correctly. Reversing the browser settlement makes the existing
  regression test's `rejects.toThrow` assertion false, and that test file was not in the owned set.
  It is now. Rewrite that test to assert the resolved settlement and to keep proving what it exists
  to prove — that `close()` before open settles the pending `start()` rather than leaving it pending
  forever. Do not delete it.*
- **Off-limits:** `src/server/transports/WebSocketClientTransport.ts` — the Node face is the one both
  faces align to, and an audit lane verified it correct. Every other file. The vendored host —
  `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/`, `.codex/`, `.cursor/`, `configs/helpers.ts`,
  `scripts/*.sh`, `tests/config.test.ts`, `tests/policy.test.ts`, `tests/setupPolicy.ts`. Do not
  hand-edit `package.json` or `vite.config.ts`. Do not change the version.

## Host conditions

- The tree is committed and clean at `bb30e34`. Untracked `tmp/` files are expected and hold this
  unit's own brief and journal — if you remove `tmp/` for A1's proof, restore it.
- **Your sandbox denies a loopback listener, a nested install, an `rm -rf`, a process one level below
  a child you spawn, and a write to some paths outside the obvious source tree.** Measured here: the
  `src:core`, `src:browser`, `src:server`, `guides`, and `distribution` projects each carry rows the
  sandbox cannot run. Never work around a denial and never change a test to suit your sandbox. Report
  each denied reading as an observation naming the exact command; the Orchestrator takes it on the
  host.
- Use `rmdir` for an empty directory, and `rm -f` for a single file.
- The network is unavailable. Do not install or fetch.
- Do not run `npm run build`, tree-wide `npm run format`, or the whole `npm test`.

## Execution

Perform this assignment directly. Spawn nothing.

## Prohibitions

- Never run `git checkout`, `git restore`, `git stash`, `git reset`, or `git clean`.
- Never commit, push, install, or read a credential.
- No `any`, no `as`, no `!`, no `@ts-ignore`, no `@ts-expect-error`, no `eslint-disable`.
- No mocks, behavioral fakes, module replacement, or framework spies.
- State no count in any prose you write, and never name a list item by its position.

## Acceptance criteria

Close them in this order and report each command with its exit code and counts.

1. With `tmp/` absent, `npm run test:distribution` reaches the packed-inventory assertions rather
   than throwing `ENOENT`. Record the reading, and record `tmp/` restored afterwards. If your sandbox
   denies the run for another reason, record how far it got before the denial and name the exact host
   command.
2. The corrected legacy-ownership pattern fails against a control importing the entity through
   `@src/core`, and the previous pattern did not. Record both readings and the exact
   plant-and-remove steps.
3. `rg -n 'reject' src/browser/transports/WebSocketClientTransport.ts` shows no rejection on the
   close-before-open path, and the browser and Node faces settle a closed-before-open `start()` the
   same way. The rewritten regression test still fails against a transport that leaves `start()`
   pending — prove that by making `close()` skip the settlement, recording the reading, and undoing
   exactly that edit.
4. `npm run lint:check` exits 0.
5. `npm run check` exits 0.
6. `npx vitest run --config vite.config.ts --project guides` exits 0. Report its counts, or report it
   as a denied observation with the exact host command.

## Deviation contract

Stop and report if the objective itself conflicts with what you find: expected, found, exact
evidence, done or not done, and at most one short hypothesis. An ancillary choice — a comment's
wording, a test's name — is yours to decide, record, and carry on from. A3's ruled direction and the
off-limits Node face are not ancillary: a conflict with either stops the unit.

## Output

Write your report to `tmp/codex/mfixc-report.md` and make it your final message too. It contains: the
files you touched and what changed in each; A1's clean-checkout reading; A4's two readings with the
exact plant-and-remove steps; your ruling on A4's guide reconciliation; the behaviour you verified
before writing A6; each acceptance criterion with its exit code and counts; an **Observations**
section for every reading your sandbox denied with the exact host command; and anything you could not
close. No process diary.
