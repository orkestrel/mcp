# mcp fix unit 3 — published specifiers in the shipped TSDoc

## Role and engine

Sol `implementer`, GPT-5.6 Sol, inside `codex exec --sandbox workspace-write` at `/home/user/mcp`.

## Objective

Close the finding the Orchestrator's artifact proof surfaced on 2026-08-20: TSDoc examples and
links in the source carry the in-repository `@src/*` alias, which ships verbatim in the built
declarations and reaches every consumer's editor, and the `createMCPRoutes` example family also
imports `createToolManager` from that alias when the symbol lives in `@orkestrel/tool` — an
example a consumer copies cannot compile.

## Context

- Read before editing: `.claude/rules/documentation.md` § Guide examples (the published-specifier
  law this extends to shipped TSDoc), `.claude/rules/typescript.md`, `.claude/rules/writing.md`.
- The tree is committed and clean at 40b5368. The executed evidence: an ESM consumer of the
  installed tarball failed on `import { createToolManager } from '@orkestrel/mcp'` (the module
  does not provide it), and the shipped `dist/src/server/index.d.ts:239` carries
  `import { createMCPLegacy, createMCPServer, createToolManager } from '@src/core'` verbatim.
- The population is TSDoc prose only — `@example` fences and `{@link import('@src/...')}` forms
  inside comment blocks. Real code imports of `@src/*` at module scope are the sanctioned in-repo
  alias, compile away, and stay untouched.
- The mapping: `@src/core` becomes `@orkestrel/mcp`; `@src/server` becomes
  `@orkestrel/mcp/server`; `@src/browser` becomes `@orkestrel/mcp/browser`; an example importing
  `createToolManager` imports it from `@orkestrel/tool` (the shipped d.ts already carries one
  correct example in that form — mirror it).
- Sweep the whole population before editing: `rg -n "@src/" src/` filtered to comment-block lines,
  and after building, `rg -c "@src/" dist` over the declaration files must reach zero.
- Standing sandbox conditions as before; the build runs in-sandbox (`npm run build` is
  network-free).

## Unknowns

- Whether a `{@link import('@src/...')}` form resolves for a consumer after rewriting to the
  published specifier is settled by the built declarations: report what the built form shows.

## Scope

- Owned: `src/` (TSDoc lines only).
- Off-limits: everything else; no code line outside a comment block moves; `tmp/` except your own
  report file.
- Permission limits: no commit, no push, no install, no `git checkout`/`restore`/`stash`/`reset`/
  `clean`, no secrets.

## Execution

You perform this assignment directly and spawn no agent.

## Output

Write your report to the `tmp/fix3-report.md` file: the sweep before and after with patterns and
paths, the per-face counts the build produced, the `createToolManager` sites corrected, and any
claim of your own you flag. End with the diffstat. No process diary.

## Deviation contract

A hit that is not TSDoc prose — a code import the sweep surfaces — is left alone and recorded, not
a deviation. A TSDoc hit whose published mapping is unclear stops the unit with the standard
report.

## Acceptance criteria (in order)

1. `npm run lint:check` exits 0.
2. `npm run check` exits 0.
3. `npm run format:check` exits 0 (run `npm run format` first if needed).
4. `npm run build` exits 0 and `rg -c "@src/" dist/src/core/index.d.ts dist/src/server/index.d.ts
   dist/src/browser/index.d.ts dist/src/core/index.d.cts dist/src/server/index.d.cts` finds no
   match.
5. `rg -n "createToolManager" src/` shows every TSDoc import of it naming `@orkestrel/tool`.

## Review evidence

Return the actual `git diff --stat` and `git status --short` output in the report. The full diff
stays in the tree for the auditor.
