# CLEAN-MCP — delete every count from this package's prose

## Role and engine

`implementer`, Opus 5.

## Objective

Delete every count and every positional reference from `/workspace/mcp`'s authored prose.

## Why this is absolute

The owner ruled it. A count in prose is a moving target whatever care goes into deciding which ones
are safe, and the deciding has already cost a design round and an audit round in this campaign. There
is no exemption for a count that is correct today. Sibling sweeps in `@orkestrel/probe` and
`@orkestrel/process` each found counts that had **already** drifted — a guide claiming a receipt
satisfies both of its conditions where four are listed, and a test comment naming two assertions where
four follow.

The rule, as it reads in `@orkestrel/scaffold`'s `AGENTS.md` § Writing:

```markdown
- **NEVER state a count.** A number answering "how many" about a set anyone can add to — rules, rows,
  members, exports, files, options, steps, cases, stages, findings, tests — is stale the moment the
  set moves, and it goes stale silently. Name the members, or write the sentence without the number.
  The reader counts when the reader needs to.
- **NEVER name a list item by its position.** Write the item's name, never `rule 4`, `the third row`,
  or `the fifth kind`. A position is a count and it moves when a row moves.
- Write a number only as a value the reader needs: a duration, a size, a limit, a version, a date, an
  exit code, or a measurement reported with the run that produced it. A value is not a count.
- Delete a count you find. Do not correct it.
```

This checkout's own `AGENTS.md` is vendored and does **not** carry that text yet; it arrives through
`repair` after scaffold publishes. Work from the text above and say so in your report.

## The line, so you do not over-reach

**Delete — these are counts:** "Three tiers", "the five codes", "four state flags", "the six
transports", "Run these eleven checks", "two of the nine", "all three", "the first two rows",
"rule 4", "the fifth kind", a test name saying "emits two events", a heading carrying a member count.

**Keep — these are values:** a duration or timeout (`5_000`, "two minutes"); a size, byte bound, or
width (`2_048`, "100 columns"); a version, date, exit code, or HTTP status (`0.0.19`, `2026-08-20`,
`404`); a measurement reported with its run ("1029 tests passed", "took 103 ms"); a threshold or range
that governs behaviour ("at most two retries"); **and every number inside code** — a literal, an
argument, an array index, an assertion such as `expect(items).toHaveLength(3)`, a constant, a numeric
type member. The ban is on prose. A number inside a fenced code block, an `@example` body, or an
expression is code.

The test: **does the number answer "how many X are there?" about a set someone could add to?** If
yes, delete it. If it is a magnitude, a bound, an identifier, or a reading, keep it.

Keep `both` where the two members are named in the same sentence or the one before — a determiner
pointing at two named things cannot drift, because adding a third makes the sentence visibly wrong.
Delete it where it tallies a set the reader could extend.

## How to rewrite

Deleting a number usually needs the sentence recast, and the recast is the work. Name the members
instead of counting them; that reads better nearly every time.

- "The two hosts terminate differently" → name the hosts.
- "The receipt is issued on four conditions together:" → "on these conditions together:".
- "seven of the nine options are shared" → name the shared options.
- A heading "The six transports" → "The transports".

Never replace one count with another.

## Context

Read before acting: `AGENTS.md` § Writing, `.claude/rules/writing.md`, `.claude/rules/documentation.md`.

Host: Linux container, bash. The tree is clean at `49475e7`. `npm test` binds a port and is slow.

## Unknowns

One. **Whether a guide count is asserted by the parity gate.** `tests/guides.test.ts` may check a
guide substring carrying a number. Where deleting a count reddens that gate, the assertion moves with
the sentence — both files are yours. Report every such pair.

## Scope

Owned: `README.md`, `guides/mcp.md`, `guides/README.md`, everything under `src/`, `tests/`,
`configs/src/`, and `scripts/`, including every TSDoc block and code comment.

**Off-limits, and the reasons differ:**

- `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/rules/`, `.claude/agents/`, `.claude/skills/` —
  vendored from `@orkestrel/scaffold`; already swept at that source and restored here by `repair`.
- `vite.config.ts`, and `package.json` — scaffold-planned. A hand edit reports as drift in
  `scaffold audit`, which is exactly how the previous unit's edit was caught.
- Every file under `guides/` except `mcp.md` and `README.md` — `contract.md`, `emitter.md`,
  `guide.md`, `process.md`, `router.md`, `scaffold.md`, `server.md`, `sse.md`, `tool.md`,
  `websocket.md`. Each is a byte-identical mirror another package owns and `scaffold catalog`
  refetches; `.claude/rules/documentation.md` § Parity refuses rewriting a mirror.
- `configs/helpers.ts`, `configs/policy.ts`, `tests/config.test.ts`, `tests/policy.test.ts`,
  `tests/setupPolicy.ts` — vendored by scaffold's host manifest. Check the manifest before editing
  anything under `configs/` or a root `tests/*.ts`.

Tools: Read, Grep, Glob, Edit, Write, Bash. No commits, no pushes, no installs, no destructive
command. Never run `git checkout`, `git restore`, `git stash`, `git reset`, or `git clean`.

## Execution

Perform this assignment yourself. Spawn nothing.

## Your sweep

Sweep case-insensitively and across both the word and the numeral form, over every owned path.
`.claude/rules/writing.md` § Substitutions requires you to name the pattern and the paths behind every
result, including a clean one.

Cover at least: cardinal words `one` through `twenty`; ordinal words `first` through `tenth`, plus
`last` and `final`; bare numerals followed by a plural noun; `all <number>`, `both`,
`exactly <number>`, `<number>-row`, `<number>-way`, `<number>-part`; and a number in a heading. Strip
fenced blocks and `@example` bodies before ruling a Markdown or TSDoc hit.

Rule every hit and report every one. A hit you keep needs its reason in one clause.

## Deviation contract

Stop and report — expected, found, exact evidence, done or not done, at most one hypothesis — when
deleting a count would change what executable code does, when a count is load-bearing in a way naming
the members cannot replace, or when a repair needs an off-limits file.

Decide and carry on, recording the choice: every recast sentence, and every hit you ruled a value.

## Acceptance criteria

Run these in order and report each bare exit code.

1. Your own sweep, re-run after the edits, reports no count and no positional reference in any owned
   path. Report the exact patterns, the exact paths, and every remaining hit with its ruling.
2. `npm run format` then `npm run format:check` exits 0.
3. `npm run lint:check` exits 0.
4. `npm run check` exits 0.
5. `npm run test:guides` exits 0.
6. `npm run test:policy` exits 0.
7. `npx vitest run --config vite.config.ts --no-cache --reporter=dot --project src:browser` exits 0.
8. `npm run test:config` exits 0.
9. `npx scaffold audit` exits 0, proving no scaffold-planned file was hand-edited.

Do not run `npm test`, `npm run build`, or `npm run test:distribution`. An independent verifier takes
those readings.

## Output

A report with: the patterns and paths of your sweep; every deleted count as a before-and-after pair,
grouped by file; every hit you ruled a value with its one-clause reason; the guide-and-gate pairs the
unknown asks for; one row per acceptance criterion with its bare exit code; and anything you could not
close.

No process diary.
