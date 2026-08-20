# MFIX-A: release what two transports acquire

## Role and engine

Role `sol` implementer. Engine GPT-5.6 Sol, high effort, sandbox `workspace-write`, rooted at
`/workspace/mcp`. You are the sole writer in this checkout for the duration of this unit.

## Objective

Close two confirmed transport defects. Each was found with an executed probe by an audit lane, and
each has a permanent test that fails before your fix and passes after it.

## Read first, in this order

1. `AGENTS.md` — in full
2. `.claude/rules/typescript.md`, `.claude/rules/architecture.md`, `.claude/rules/patterns.md`,
   `.claude/rules/tests.md`
3. `guides/mcp.md` — the governing spec
4. `src/browser/types.ts` and `src/server/types.ts` — authoritative for the public contracts

## The findings

**F1. `MessagePortTransport` leaves its listeners attached after `close()`.**

`src/browser/transports/MessagePortTransport.ts` attaches anonymous `message` and `messageerror`
listeners and never removes them. The audit's executed probe reported:

```text
before:              message=1 messageerror=1
after transport.close: message=1 messageerror=1
named-listener control: armed=1 released=0
```

Retain both listener functions as bound `readonly #` fields, remove them in `close()`, and clear the
registered callbacks. A caller who closes the transport must be able to close the port's other side,
or transfer the port, without this transport still receiving on it.

**F2. `WebSocketClientTransport.close()` does not settle a `start()` made while connecting.**

`src/browser/transports/WebSocketClientTransport.ts` — and check
`src/server/transports/WebSocketClientTransport.ts` for the same shape, because the two are mirrors
and the audit probed only one. A `start()` call awaiting the handshake never settles if `close()`
runs before the socket opens. The audit's executed EventTarget probe reported:

```text
after close: subject=pending open-listeners=1 error-listeners=1
rejection control: control=rejected
```

Retain the handshake cleanup and its rejector so `close()` removes both temporary listeners and
settles the pending `start()`. Decide whether the settle is a rejection or a resolution and state
your reasoning in the report; a caller must be able to tell a closed-before-open from a failed
handshake.

## Scope

- **Owned:** `src/browser/transports/MessagePortTransport.ts`,
  `src/browser/transports/WebSocketClientTransport.ts`,
  `src/server/transports/WebSocketClientTransport.ts`, `src/browser/types.ts`, `src/server/types.ts`,
  and the test files under `tests/src/browser/` and `tests/src/server/transports/` that cover them.
- **Shared, report-only:** `guides/mcp.md`. If your change makes a guide statement false, return the
  exact replacement text in your report. Do not edit the guide; a second unit owns it.
- **Off-limits:** every other file. In particular the vendored host — `AGENTS.md`, `CLAUDE.md`,
  `.agents/`, `.claude/`, `.codex/`, `.cursor/`, `configs/helpers.ts`, `scripts/*.sh`,
  `tests/config.test.ts`, `tests/policy.test.ts`, `tests/setupPolicy.ts` — is owned by
  `@orkestrel/scaffold` and restored by `repair`. Editing one is reverted and reported as drift.
  `package.json` and `vite.config.ts` are scaffold-planned; do not hand-edit either.

## Host conditions

- The tree is committed and clean. Untracked `tmp/` files are expected.
- Both subjects test in-process: `MessagePortTransport` against a real `new MessageChannel()`, and
  the WebSocket transports against a real in-process `node:http` server. Neither spawns a child
  process, so neither meets the sandbox's grandchild denial.
- The network is unavailable. Do not install, fetch, or run anything that reaches the registry.
- Do not run `npm run build`, tree-wide `npm run format`, or `npm test`. Validate scoped to your own
  files.

## Execution

Perform this assignment directly. Spawn nothing.

## Prohibitions

- Never run `git checkout`, `git restore`, `git stash`, `git reset`, or `git clean`. Each discards a
  working-tree change silently, and this tree has no other copy of your work. To undo your own edit,
  undo exactly that edit.
- Never commit, push, install, or read a credential.
- No `any`, no `as`, no `!`, no `@ts-ignore`, no `@ts-expect-error`, no `eslint-disable`.
- No mocks, behavioral fakes, module replacement, or framework spies. Use the real implementations
  the existing tests already use.
- State no count in any prose you write — no number answering "how many" about a set anyone can add
  to, and no naming a list item by its position. This includes TSDoc, comments, and test names.

## Acceptance criteria

Close them in this order and report each command with its exit code.

1. A permanent test for F1 fails against the unfixed source and passes against the fixed source.
   Record both readings with the exact command and its counts.
2. A permanent test for F2 fails against the unfixed source and passes against the fixed source, for
   each WebSocket client transport you changed. Record both readings.
3. `npm run lint:check` exits 0.
4. `npm run check` exits 0.
5. `npx vitest run --config vite.config.ts --project src:browser` exits 0. Report its counts.
6. `npx vitest run --config vite.config.ts --project src:server` exits 0. Report its counts.

Report the whole-suite result as an observation if you take it, never as a criterion.

## Deviation contract

Stop and report if the objective itself conflicts with what you find: expected, found, exact
evidence, done or not done, and at most one short hypothesis. Do not investigate beyond that or
alter the plan. An ancillary choice — where a field sits, what a test is named — is yours to decide,
record, and carry on from.

## Output

Write your report to `tmp/codex/mfixa-report.md` and make it your final message too. It contains:
the files you touched and what changed in each; the red-then-green readings with exact commands and
counts; each acceptance criterion with its exit code; your ruling on the F2 settle shape and why;
any exact guide replacement text for the second unit; and anything you could not close. No process
diary.
