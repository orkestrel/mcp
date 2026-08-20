# CLEAN-MCP — delete every count from this package's prose

## Role and engine

`implementer`, Opus 5. Prose judgment across every surface a developer or an agent reads.

## Objective

Delete every count and every positional reference from `/workspace/mcp`'s prose, so no sentence anywhere in
this package states how many of something there are.

## Why this is absolute

The owner ruled it, after a count drift cost a full audit round in one package and a design round in
another. A count in prose is a moving target that goes stale silently: nothing fails, no gate reads
it, and the next reader believes it. There is no exemption for a count that is correct today.

The rule now reads, in `/workspace/mcp/AGENTS.md` § Writing:

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

Read it there rather than from this brief; if the two disagree, the file wins.

## The line, so you do not over-reach

**Delete — these are counts:**

- "Three tiers divide by lifetime", "the five codes", "four state flags", "the six classes"
- "Follow these rules" preceded by a number, "Run these eleven checks"
- "two of the nine options", "seven of them", "all three"
- "the first two rows", "rule 4", "the fifth kind", "the third bullet", "the last two"
- a test name or a comment saying "returns three findings", "emits two events"
- a heading carrying a number of members

**Keep — these are values, not counts:**

- a duration, a timeout, a deadline: `5_000`, "two minutes", "within 30 seconds"
- a size, a byte bound, a column width, a dimension: `2_048`, "100 columns", `24x24`
- a version, a date, an exit code, an HTTP status: `0.0.4`, `2026-08-20`, `404`
- a measurement reported with its run: "148 tests passed", "took 2853 ms"
- a threshold or a range that governs behaviour: "at most two retries", "4 to 8 events"
- **every number inside code**: a literal, an argument, an array index, an assertion such as
  `expect(items).toHaveLength(3)`, a constant, a type's numeric member. The ban is on prose.
  A number inside a fenced code block, a `@example` body, or an expression is code.

The test: **does the number answer "how many X are there?" about a set someone could add to?** If
yes, delete it. If it is a magnitude, a bound, an identifier, or a reading, keep it.

## How to rewrite, not just delete

Deleting a number usually needs the sentence recast, and the recast is the work.

- "Three tiers, divided by lifetime:" becomes "The tiers divide by lifetime:".
- "The receipt is issued on four conditions together:" becomes "The receipt is issued on these
  conditions together:".
- "seven of the nine options are shared" becomes the shared options named.
- "the bound in rule 4" becomes the bound named by what that rule is about.
- A heading "The six classes" becomes "The classes".

Where the count is load-bearing for the reader's understanding, name the members instead of counting
them. Never replace one count with another.

## Context

Read before acting: `/workspace/mcp/AGENTS.md` § Writing, `/workspace/mcp/.claude/rules/writing.md`, and
`/workspace/mcp/.claude/rules/documentation.md`.

Host: Linux container, bash. `/workspace/mcp` is a clean checkout. `npx scaffold audit` resolves normally here. This package has no `test:distribution`. `npm test` binds real ports and is slow.

## Unknowns

One. **Whether a guide count is asserted by the parity gate.** `tests/guides.test.ts` may check a
guide substring that carries a number. Where deleting a count reddens that gate, the assertion moves
with the sentence — both files are yours. Report every such pair.

## Scope

Owned files: every prose surface in `/workspace/mcp` — `AGENTS.md`, `CLAUDE.md`, `README.md`, everything
under `guides/`, `.agents/`, `.claude/`, and every TSDoc block and code comment under `src/`, `app/`,
`tests/`, `configs/`, and `scripts/`.

`AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/rules/`, `.claude/agents/`, and `.claude/skills/` are vendored copies of `@orkestrel/scaffold`'s and are **off-limits** — the rule already landed at the source and its bytes arrive here through `repair`. `configs/helpers.ts`, `configs/policy.ts`, every `scripts/*.sh`, `tests/config.test.ts`, `tests/policy.test.ts`, and `tests/setupPolicy.ts` are vendored too, and are off-limits for the same reason. Under `guides/`, only `guides/mcp.md` is this package's own; every other guide there is a fetched mirror of another package's and is off-limits. Everything else — `README.md`, `src/`, and the tests that mirror it — is yours.

Off-limits: `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, everything under
`dist/`, `node_modules/`, and `.orkestrel/`. Do not change any executable code — no literal, no
argument, no assertion, no constant, no type. This unit rewrites prose and nothing else.

Tools: Read, Grep, Glob, Edit, Write, Bash. No commits, no pushes, no dependency installs, no
destructive command. Never run `git checkout`, `git restore`, `git stash`, `git reset`, or
`git clean`.

## Execution

Perform this assignment yourself. Spawn nothing.

## Your sweep

Sweep case-insensitively and across both forms — the word and the numeral — over every owned path.
`.claude/rules/writing.md` § Substitutions requires you to name the pattern and the paths behind
every result, including a clean one.

Cover at least: cardinal words `one` through `twenty`; ordinal words `first` through `tenth`, plus
`last` and `final`; bare numerals followed by a plural noun; `all <number>`, `both`, `exactly
<number>`, `<number>-row`, `<number>-way`, `<number>-part`; and a number in a heading.

`both` is a count of two. Delete it where it tallies a set the reader could add to; keep it where it
means "each of these two named things" and naming them is what the sentence does.

Rule every hit and report every one. A hit you keep needs its reason in one clause.

## Deviation contract

Stop and report — expected, found, exact evidence, done or not done, at most one hypothesis — when:

- deleting a count would change what executable code does;
- a count is load-bearing in a way naming the members cannot replace;
- a repair needs a file this brief marks off-limits.

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
7. `npx vitest run --config vite.config.ts --no-cache --reporter=dot --project src:core` exits 0.
8. `npm run test:config` exits 0.

Do not run `npm test`, `npm run build`, or `npm run test:distribution`. An independent verifier takes
those readings.

## Output

A report with: the patterns and paths of your sweep; every deleted count as a before-and-after pair,
grouped by file; every hit you ruled a value, with its one-clause reason; the guide-and-gate pairs
the unknown asks for; one row per acceptance criterion with its bare exit code; and anything you
could not close.

No process diary.
