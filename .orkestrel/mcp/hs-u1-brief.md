# HS-U1: client negotiation and pin fidelity

## Role and engine

Sol `implementer`, GPT-5.6 Sol, inside `codex exec --sandbox workspace-write` at `/home/user/mcp`.

## Objective

Close the client half of the reconciled handshake design: the probe-deadline law and pin fidelity
on both eras, with the behavioral tests that bind them.

## Context

- Read before editing: the `AGENTS.md` file, `.claude/rules/typescript.md`,
  `.claude/rules/names.md`, `.claude/rules/patterns.md`, `.claude/rules/tests.md`, the
  `tmp/handshake-reconciliation.md` file (binding rulings), and the evidence its README indexes
  under `tmp/handshake-evidence/`.
- The tree is committed and clean at commit 26024f5. No other writer runs.
- Verified code facts, 2026-08-20: `src/core/MCPClient.ts:219-222` sets `#probe` to
  `Math.min(options.timeout, DEFAULT_MCP_PROBE_TIMEOUT)` when `options.timeout` is defined and to
  `DEFAULT_MCP_REQUEST_TIMEOUT` otherwise; `src/core/constants.ts:181-184` holds both constants;
  `isMCPVersion` is exported at `src/core/validators.ts:1218`; `MCP_UNSUPPORTED_VERSION = -32022`
  at `src/core/constants.ts:83`; `#pin`/`#offer` at `src/core/MCPClient.ts:216-217`; the legacy
  `#initialize` accepts any supported legacy revision without comparing `#pin` near
  `src/core/MCPClient.ts:856-874`. Line numbers can drift; re-locate by pattern.
- Standing sandbox conditions: no network; in-process scoped runs are reliable; a spawned child's
  stdio is not — every proof in this unit is in-process.

## The items

1. **Delete the probe cap.** Remove `DEFAULT_MCP_PROBE_TIMEOUT` from `src/core/constants.ts`
   (no alias, no shim), remove the `#probe` field, its assignment, and its import from
   `src/core/MCPClient.ts`, and pass `this.#timeout` wherever `#probe` was passed. Strike the
   cap clause from the `timeout` TSDoc in `src/core/types.ts` (near :2481) and anywhere else in
   `src/core/` the cap is stated. Do not touch `guides/mcp.md` — a later unit owns it.
2. **Construction pin refusal.** In the `MCPClient` constructor, before the emitter is created
   and before any transport subscription: read `options.version` once; when it is defined and
   `isMCPVersion` refuses it, throw `MCPError` with the `MCP_UNSUPPORTED_VERSION` code and
   context `{ supported: SUPPORTED_PROTOCOL_VERSIONS, requested }`. Update the `version` option
   TSDoc in `src/core/types.ts` to state the exact-pin contract and the synchronous construction
   failure, and the `MCPError` remark in `src/core/errors.ts` to state that this error also
   reports locally detected protocol incompatibility.
3. **Exact pin, modern path.** In `#negotiate` (or the seam that consumes a discovery result):
   when `#pin` is defined, require the validated `supportedVersions` to contain exactly the pin;
   select the pin itself rather than inferring; on absence throw `MCPError`
   `MCP_UNSUPPORTED_VERSION` with `{ supported, requested }`. A pinned modern client never falls
   back to legacy.
4. **Exact pin, legacy path.** In `#initialize`: after validating that the reply carries a
   supported legacy revision, compare it with a defined `#pin`; on mismatch throw `MCPError`
   `MCP_UNSUPPORTED_VERSION` with `{ requested, negotiated }`, before `notifications/initialized`
   is sent and before connection state installs. The failed attempt closes the connection it
   opened under the existing ownership rules.
5. **Behavioral tests.** In `tests/src/core/MCPClient.test.ts`:
   - Replace the source-text assertion that pins the constructor's `Math.min(options.timeout,
     DEFAULT_MCP_PROBE_TIMEOUT)` spelling (near :1086) with a behavioral assertion: a client
     constructed with `timeout: 15_000` applies a 15_000ms deadline to its negotiation probe,
     asserted from the deadline the client applies, never from elapsed time. Replace, do not
     delete.
   - Add: an invalid runtime pin throws `MCPError` synchronously from construction, exercised
     through a value crossing an `unknown` boundary (the reconciliation names
     `Reflect.apply(createMCPClient, undefined, [options])` as one sanctioned form) — never
     through `any`, an assertion, or a suppression.
   - Add: a pinned modern client rejects a discovery result that does not advertise the pin.
   - Add: a pinned legacy client rejects an `initialize` reply whose `protocolVersion` differs
     from the pin, and sends no `notifications/initialized` after the mismatch.
   - Every new proof runs in-process against scripted transports of the kind the file already
     uses.

## Unknowns

- Whether a seam other than `discover()` reads `#probe`. Sweep for the field before deleting and
  report every consumer you rewired.

## Scope

- Owned: `src/core/MCPClient.ts`, `src/core/constants.ts`, `src/core/types.ts`,
  `src/core/errors.ts`, `tests/src/core/MCPClient.test.ts`.
- Off-limits: `guides/mcp.md`, `README.md`, `src/core/MCPServer.ts`, `src/core/MCPLegacy.ts`,
  `src/server/**`, `src/browser/**`, `tests/guides.test.ts`, `tests/distribution.test.ts`,
  `tmp/` except your own report file.
- Permission limits: no commit, no push, no install, no `git checkout`/`restore`/`stash`/
  `reset`/`clean`, no secrets.

## Execution

You perform this assignment directly and spawn no agent.

## Deviation contract

A conflict with a reconciliation ruling stops the unit with the standard report — expected,
found, exact evidence, done or not done, one short hypothesis. Test placement inside the owned
test file and TSDoc sentence form are yours to decide and record.

## Output

Write your report to the `tmp/hs-u1-report.md` file: per item what changed with file:line, every
`#probe` consumer you rewired, the red/green readings for each new proof where you ran one, then
`git diff --stat` and `git status --short`. No process diary.

## Acceptance criteria (in order)

1. `rg -n "DEFAULT_MCP_PROBE_TIMEOUT|#probe" src/` returns no hit.
2. `npm run lint:check` exits 0.
3. `npm run check` exits 0.
4. `npm run format:check` exits 0 (run `npm run format` first if needed).
5. The scoped run over the owned test file exits 0; paste the count lines.
6. The replaced probe assertion is behavioral: the test names a deadline the client applies, and
   no assertion in the file reads the constructor's source text.

## Review evidence

The actual `git diff --stat` and `git status --short` output in the report. The full diff stays
in the tree for the auditor.
