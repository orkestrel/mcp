# mcp readiness fix unit

## Role and engine

Sol `implementer`, GPT-5.6 Sol, inside `codex exec --sandbox workspace-write` at `/home/user/mcp`.

## Objective

Close every accepted readiness finding in the `tmp/readiness-matrix.md` file that names the mcp fix unit as carrier: MR1 through MR6 and MR9 through MR17.

## Context

- Read before editing: the `AGENTS.md` file, `.claude/rules/names.md`, `.claude/rules/typescript.md`, `.claude/rules/architecture.md`, `.claude/rules/writing.md`, `.claude/rules/tests.md`, `.claude/rules/documentation.md`, the `guides/mcp.md` guide, and the `tmp/readiness-matrix.md` file.
- The tree is committed and clean at dispatch. `node_modules` is installed. The gates are `npm run format:check`, `npm run lint:check`, `npm run check`, `npm run build`, `npm test`.
- Standing conditions of this sandbox: no network; a loopback listener may be denied `EPERM`; a process one level below a test may be denied. If a scoped test run fails on such a denial, record the exact command as an observation and continue; the Orchestrator takes the reading on the host. The browser test project cannot run here; leave it to the host.
- The findings, restated with their prescriptions:
  - **MR1**: substitution-table hits in authored TSDoc and guide (`SHOULD`, `WHITELIST`, `via`, `e.g.`, `dummy`, causal `since`, `currently`; guides/mcp.md:767 and the named source lines). Sweep case-insensitively, rule each hit by sense, keep literal protocol terms, and name the pattern and paths.
  - **MR2 + MR15**: README.md:43 passes `{ name, version, tools }` where `MCPServerOptions` requires `identity` (types.ts:1776), and the example fails typecheck. Correct the example so it typechecks against the real types.
  - **MR3 + MR14**: README guide links target the absent `guides/src/mcp.md` path and the tarball excludes guides. Point them at destinations an installed consumer can reach (the repository URL form). Add `README.md` to `ROOT_FILES` in tests/guides.test.ts so the link gate reaches it; run that gate red first if the links are still dead, then green.
  - **MR4**: the guide's bare `tools/list` example (guides/mcp.md:215) claims success; executing it returns -32602; the stamped control succeeds. Stamp every bare modern example in the guide.
  - **MR5**: guides/mcp.md:4093 claims unbounded default discovery; MCPClient.ts:219 assigns the default request deadline. Reconcile the prose with the type documentation and the implementation.
  - **MR6**: the upgrade handler in src/server/factories.ts claims `Sec-WebSocket-Protocol: mcp` when the client offered no subprotocol; RFC 6455 requires the client to reject an unsolicited subprotocol, and tests/src/browser/factories.test.ts:134 records it. Claim the header only when the offer list carries the configured protocol. Add the missing-offer, mismatched-offer, and matching-offer handshake proofs, red then green where the sandbox allows; where the sandbox denies a listener, record the exact commands for the host.
  - **MR9**: rename `SubscriptionsListenResult` to `MCPSubscriptionResult` and `SubscriptionsListenResultMetaObject` to `MCPSubscriptionResultMetaObject` (types.ts:1332, :1338), sweeping every consumer in src, tests, and the guide. A residue sweep proves no old name remains.
  - **MR10**: `MCPClientTransportInterface` TSDoc is false of the server-bridge implementers. Document the shared role the interface actually plays. Add one row to `ROADMAP.md` recording the rename as a decision deferred past this wave.
  - **MR11**: delete the `MCPClient.on` delegation (MCPClient.ts:252-257); consumers use the exposed `emitter` property. Remove `on` from `MCPClientInterface` if it is declared there, and update every call site in src and tests.
  - **MR12**: move `isFormElicitationSupported` and `isTaskSupported` from `validators.ts` to `helpers.ts`; update imports and the guide's placement rows.
  - **MR13**: add the missing `duplex` row to the guide's transport interface table.
  - **MR16**: the guide's map-size figures contradict each other. Measure the value once, state it with the date, and remove the contradicting figure.
  - **MR17**: authored TSDoc first sentences use the bare imperative where the canon requires the third-person `-s` form. Sweep and correct authored TSDoc; leave quoted protocol text alone.

## Unknowns

- Whether the handshake proofs can run inside this sandbox is unknown; report the outcome with exact commands either way.

## Scope

- Owned: `src/`, `tests/`, `guides/mcp.md`, `README.md`, `ROADMAP.md`.
- Off-limits: `package.json`, `vite.config.ts`, `tsconfig.json`, `.claude/`, `.agents/`, `tests/setupPolicy.ts`, `tests/policy.test.ts` (vendored), `tmp/` except your own report file.
- Permission limits: no commit, no push, no install, no `git checkout`/`restore`/`stash`/`reset`/`clean`, no secrets.

## Execution

You perform this assignment directly and spawn no agent.

## Output

Write your report to the `tmp/fix-report.md` file: per finding, what changed with file:line, red and green readings with exact commands (or the sandbox-denial observation), the MR1/MR17 sweep patterns and paths with per-hit sense rulings where a hit was kept, and any claim of your own you flag. End with the diffstat. No process diary.

## Deviation contract

A conflict with a finding's prescription stops the unit with a report: expected, found, exact evidence, done or not done, one hypothesis at most. An ancillary choice (sentence form, row placement) is yours to decide and record.

## Acceptance criteria (in order)

1. `npm run lint:check` exits 0.
2. `npm run check` exits 0.
3. `npm run format:check` exits 0 (run `npm run format` first if needed).
4. `rg -n "SubscriptionsListenResult" src/ tests/ guides/ README.md` returns no hit.
5. `rg -n "guides/src/mcp.md" README.md` returns no hit, and `ROOT_FILES` in tests/guides.test.ts contains `README.md`.
6. The MR1 sweep result names its pattern and paths and leaves no banned-sense hit in the named files.
7. `MCPClient` declares no `on` method and no test calls `client.on(`.
8. Scoped vitest runs over touched server/core test files pass, or their denial is recorded with exact commands. Whole-suite, browser, and timing readings are observations, never criteria.

## Review evidence

Return the actual `git diff --stat` and `git status --short` output in the report. The full diff stays in the tree for the auditor.
