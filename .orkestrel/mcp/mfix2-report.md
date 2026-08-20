# MFIX2 — report

Unit: `implementer`, Opus 5. Brief: `mfix2-brief.md`. Findings M6, M8, M10, M12, plus the guide
sentences `0489f0e` falsified.

## M6 — the guide now says what the code does

The security-adjacent one first. The guide told a consumer that a provided `env` **replaces**
`process.env`. It merges over it. The sentence now reads that each named key overrides the inherited
value, every unlisted key is still inherited, and `env: { TOKEN: 'x' }` hands the child the parent's
whole environment plus `TOKEN` — and adds the limit the old sentence hid: this transport exposes no
way to withhold `process.env` from the child.

The stdio attribution was wrong in the guide and the README both: it constructs `@orkestrel/process`'s
`Process`, not `node:child_process.spawn`, and that supervisor pipes stderr into a bounded tail rather
than inheriting the parent's.

**The instrument is the best this campaign produced.** It compares the child's `fstatSync(2)` device
and inode against the parent's, which discriminates a fresh pipe from an inherited descriptor. Its
control is a raw `spawn` with `env` replacing and `stdio` inheriting, and that control reports
`path: undefined` and an identical stderr identity — the exact readings the two false sentences
predicted. The falsehood and its refutation sit in one test.

The close universal, the always-passed `fetch` signal, the request error that now resolves `start()`,
the WebSocket close, and the contract row are all corrected, and `stop()`'s teardown is documented for
the first time — the behaviour the last several commits existed for had appeared only in a private
class doc and in commit messages.

## M8 — a second `bridge()` refuses

`#bridged` guards it, raised before `getReader()` so a mis-wired stream stays bridgeable elsewhere.

The leak was observed directly rather than only through the refusal: with the throw removed, the
orphaned first interval kept writing — 4 comments at release, 9 fifty milliseconds later.

## M10 — the defect class removed rather than patched

The brief offered two options: hoist the `seen` set, or pass a clear alongside. The unit took a third.
`teardowns` became `Map<MessagePort, () => void>`, so membership **is** the dedup and `clear()` drops
the binding and the port together. Two collections over one lifetime is what let one be forgotten, and
`AGENTS.md` § Design laws forbids storing a second fact that can drift. `serveMCPScope`'s disposer
needed no new clear at all.

Its red is a stack frame rather than an assertion: `TypeError: teardowns.add is not a function`.

## M12 — the distribution gate, and a packaging ruling the compiler settled

The gate follows `@orkestrel/process`'s shape with three departures this package's form required:
declaration names are deduplicated before comparison, because `buildModernResult` is an overload pair
whose statement count exceeds its export count while the sets agree; the `require` refusal of
`@orkestrel/mcp/browser` is asserted rather than skipped; and the consumer's dependency list is
derived from the packed manifest rather than written down a second time.

**The `types` ruling was measured, not reasoned.** The unit compiled a real consumer against the
installed tarball under every resolution mode. `node16`, `nodenext`, and `bundler` are clean; `node10`
fails on `/browser` and `/server` and **not** on the root, because legacy resolution falls back to
`main` and finds `dist/src/core/index.d.ts` beside it. So a root `types` field would change nothing,
the real closer would be `typesVersions` for the two subpaths, and this package declines that because
its supported floor is `node16`. The guide's stated reason was wrong and now says what the compiler
reports.

## Two things the Orchestrator closed

**A contradiction the unit refused to resolve alone.** `README.md` said Node >= 24 while `engines`
says `>=22.12.0`, and the whole suite plus the distribution install ran green on Node 22.22.2. The
unit left it, correctly, as the manifest owner's call. Ruled: `engines` wins, and the README now reads
`>= 22.12.0`, matching `@orkestrel/process`'s own convention.

**A patch for an off-limits file.** `src/server/helpers.ts` carried the `extractLines` falsehood twice
in `dispatchLines`'s TSDoc — the client transport takes its frames from the supervisor's `lines`
iterable and never calls it. Applied as returned.

## A dispatch defect, and the mechanism that caught it

`npx scaffold audit` failed: `vite.config.ts` drifted `stale`. **The brief granted that file, and it
should not have.** It is scaffold-planned, and scaffold derives the `distribution` project from the
presence of `tests/distribution.test.ts` — `DISTRIBUTION_TEST_PATH` in
`@orkestrel/scaffold/src/core/constants.ts` says so. The unit's hand-written project was placed after
`integration` rather than before it, carried a `browser: { enabled: false }` the plan does not have,
and carried a hand comment the plan does not have.

The correct mechanism is the proof file plus `scaffold overwrite`, and running it produced the
canonical bytes. The audit reports 0 of 131 planned paths drifted.

That same `overwrite` regenerated the catalog and fetched the guide mirrors, which added
`guides/process.md` to this package for the first time — and **the fetched mirror carries the swept
prose**: "A typed child-process toolkit in tiers", "The tiers divide by lifetime", zero count hits.
Sweeping a package at its source and pushing it is what cleans every consumer's mirror of it. The
fleet-wide count cleanup propagates mechanically rather than by hand.

## Gate evidence

After the regeneration: `format:check`, `lint:check`, `check`, `test:config` (28), `test:guides`
(129), `test:distribution` (1), and `scaffold audit` (0 of 131 drifted) all exit 0. The verifier's
readings before it: `test:src` 30 files, 1033 tests; `test:policy` 86; `test:conformance` 4;
`test:integration` 4.
