# MCP-AUDIT — the round that gates @orkestrel/mcp 0.0.20

## What this round decides

Whether `@orkestrel/mcp` is bumped to 0.0.20 and published. It sits in the middle of a release wave:
`@orkestrel/process` 0.0.4 publishes first, `@orkestrel/mcp` re-pins and follows, and
`@orkestrel/probe` 0.0.1 — a package that has never published — depends on `@orkestrel/mcp` and
cannot publish until it does. A defect that survives this round reaches two packages and a first
release.

A finding is worth more than a clean pass. The alternative to finding it here is a consumer finding
it after publication, when the version number is already spent.

## The subject

`/workspace/mcp` at `48ded67` on branch `main`. Two commits since the published 0.0.19, and **no
round has audited either of them**. This is the first adversarial pass over them.

| Commit | Claimed |
| ------ | ------- |
| `ec65d53` | `StdioServerTransport.start()` attached three listeners that `close()` removed none of; `createStdioServer` discarded the unbind `bindServer` returns. Both fixed, handlers removed on both close paths, `stop()` calls unbind before closing. Injected streams stay caller-owned. |
| `48ded67` | Removing listeners was necessary and not sufficient: `readable.on('data')` puts a stream into flowing mode and refs its handle. `close()` now calls `pause()` — but only when this transport started the flow, decided by reading the input's `data` listener count immediately before attaching. |

Both commit messages carry red-then-green counts and a settling proof against the published 0.0.19.
Those are the author's claims, made by the party least able to test them.

## The mechanism under audit

`src/server/transports/StdioServerTransport.ts`:

- `:50` — `#ownsFlow = false`
- `:79` — `this.#ownsFlow = this.#input.listenerCount('data') === 0`, evaluated in `start()`
  immediately before attaching
- `:116-118` — three `removeListener` calls in `close()`
- `:119` — `if (this.#ownsFlow) this.#input.pause()`

## Already established — do not re-run

The Orchestrator dispatched an independent verifier over this tip. Its gate report is at
`.orkestrel/mcp/mcp-audit-gates.md`. Read it rather than re-running the suite; attack what green
does not prove.

Two standing conditions about this container, so you do not report them as findings:

- `npm test` binds a port. Inside a sandbox that denies it, the run fails with `EPERM` on
  `0.0.0.0:24678` **before collection**, which is the sandbox and not the code. Do not read that as a
  defect and do not try to work around it.
- The tree is clean at `48ded67` apart from files this round writes under `.orkestrel/mcp/` and
  `tmp/`.

## Numbered claims

Attack each. `CONFIRMED` requires naming the attack you tried that failed. A claim you cannot decide
is `UNRESOLVED`, not `CONFIRMED` — say what would settle it. Do not hedge toward an imagined
consensus.

**1. The ownership test is sound under interleaving.** `#ownsFlow` is decided once, in `start()`,
from a listener count read a moment before this transport attaches. Claim: there is no ordering of
attach, third-party attach, third-party detach, and `close()` that makes the recorded answer wrong —
either pausing a stream this transport did not put into flowing mode, or failing to pause one it did.
Note that this is a concurrency claim, so it is falsified by an interleaving rather than by an input.
Enumerate the orderings yourself.

**2. `pause()` is not a seizure of a caller-owned stream.** The commit rules that `pause()` reverses
exactly the state change this transport made and that a caller who wants to read again resumes or
attaches a listener. Claim: that ruling holds for every caller pattern a consumer could reasonably
have — including one that attached its own `data` listener after `start()` and is still reading when
`close()` runs.

**3. Nothing forbidden is called.** Claim: no path in this package calls `destroy`, `end`, or
`removeAllListeners` on an injected stream. Enumerate the surface yourself rather than trusting the
commit message's "verified by search"; that search's membership rule is exactly what a prior round in
a sibling package got wrong.

**4. Both close paths remove exactly what they attached.** `close()` and the input's own `close`
event both tear down. Claim: neither leaks a listener, neither double-removes in a way that would
strip a caller's own handler, and a `close` event arriving while `close()` is executing does not
produce a wrong result.

**5. `stop()` orders the unbind before the transport close, and that order matters.** Claim: the
ordering is correct, and reversing it would produce an observable defect. If reversing it produces no
observable difference, say so — an ordering nobody can break is not an invariant.

**6. The containment has no remaining door.** This package ships six transports:
`StdioServerTransport`, `StdioClientTransport`, `HTTPClientTransport`, `HTTPDisconnect`,
`WebSocketClientTransport`, `WebSocketServerTransport`. The two commits repaired the first one.
Claim: **no other transport in this package has the same class of defect** — an acquired listener,
handle, socket, timer, or flowing stream that its own teardown does not release. Enumerate every
transport's acquire and release paths yourself and rule on each. This is the claim most likely to
find something; treat it as the centre of the round rather than the tail.

**7. No refusal or teardown was widened into a regression.** Claim: no legitimate caller pattern that
worked against the published 0.0.19 stops working against this tip. Name the pattern if one did.

**8. The package's own instruments bind.** Claim: for the tests these two commits added, a control
exists that makes each fail. Pick the ones you consider most likely to be tautological — a test that
asserts the state it just set, or that drives a code path through an internal rather than through the
public seam — and actually attack them. Say how many you attacked.

**9. The guide is true, not merely plausible.** Claim: every behavioural sentence in this package's
guide about transport lifetime, stream ownership, and teardown describes what the code does. Ask
specifically whether a false universal has been replaced by an unfalsifiable one, which is worse,
because it reads as rigour.

**10. Nothing proves the published artifact.** The verifier found that this package defines no
`test:distribution` script, while `@orkestrel/process` and `@orkestrel/probe` each pack themselves,
install the tarball outside the repository, and assert every `exports` target resolves, both module
formats load for both entries, and each entry's runtime export set equals its `.d.ts`
value-declaration set. Claim: **this package's `exports` map, `files` list, and built output are
correct anyway**, and nothing a distribution proof would catch is currently wrong. Check the map
against the built tree yourself. Where you cannot decide without packing, say so and name that as
what would settle it.

**11. Would you publish this?** Claim: nothing in this package leaves a seam that no single diff
shows — a vocabulary that drifted, an option two sections describe differently, a lifecycle documented
in one place and implemented in another.

## Unknowns

- Whether `@orkestrel/probe` exercises the repaired path is not established here. Report anything you
  can determine from this tree alone and name what you could not check.
- This package's runtime pin on `@orkestrel/process` is `^0.0.3` and will move to `^0.0.4` after that
  package publishes. It uses `Process` and `PROCESS_GRACE`, neither of which the 0.0.4 rename
  touched. If you find any other `@orkestrel/process` surface this package reaches, name it.

## Where a probe may live

Write every executable probe as `tmp/probe/<distinct-name>.test.ts` and run it with
`npm run test:probe`. That project exists for exactly this — `vite.config.ts:236-237` includes
`tmp/probe/**/*.test.ts` and `package.json` runs it — and the directory is git-ignored. A probe
written anywhere else is either not discovered at all or is discovered by a project it does not
belong to and fails a run nobody caused. Delete every probe you wrote before you return.

Give your files a distinct prefix so they cannot collide with the other lane's. Never run the whole
gate suite: the verifier's readings are in **Already established**, `npm test` fails on a port bind
in a sandbox, and a tree-wide run while this round is live sees the other lane's in-flight files.

## Review evidence

Every path is relative to `/workspace/mcp`.

- `.orkestrel/mcp/mcp-audit-diff.txt` — the actual diff, `a177f8e..48ded67`, which is everything
  since the published 0.0.19.
- `.orkestrel/mcp/mcp-audit-log.txt` — the actual `git log --oneline` for that range and the actual
  `git status --short`.
- `.orkestrel/mcp/mcp-audit-gates.md` — the independent verifier's gate report for the tip.
- `.orkestrel/mcp/m1-brief.md` and `m1fix-brief.md` — what the two units were told to do.
- The working tree is the tip, so `src/`, `tests/`, and `guides/` read as published.

## Read before ruling

`AGENTS.md`, `.claude/rules/typescript.md`, `.claude/rules/patterns.md`, `.claude/rules/tests.md`,
`.claude/rules/quality.md`, and this package's guide under `guides/`.

## Your verdict

Return exactly the shape `.agents/skills/orkestrel-falsify/SKILL.md` § Verdict shape fixes: numbered
verdicts in this brief's order, each `CONFIRMED`, `BROKEN`, `UNRESOLVED`, or `NOT-EVIDENCED` with the
evidence that value requires; then any findings fitting no claim, each substantiated to the `BROKEN`
standard; then one terminal line and only one.

No process diary. No summary of what you read.
