# MFIX2 — the guide tells the truth, and two leaks close

## Role and engine

`implementer`, Opus 5. Guide truth, two lifecycle leaks, and one missing gate.

## Objective

Close findings M6, M8, M10, and M12 from `.orkestrel/mcp/mcp-audit-reconciliation.md`, plus the four
guide sentences `0489f0e` falsified.

## Context

Read before acting: `AGENTS.md`, `.claude/rules/documentation.md`, `.claude/rules/tests.md`,
`.claude/rules/quality.md`, `.orkestrel/mcp/mcp-audit-reconciliation.md`, and
`.orkestrel/mcp/mfix1-report.md` — the last names the sentences the transport fixes made false.

The tree is clean at `0489f0e`. `npm test` binds real ports and is slow.

## M6 — the guide is false in eight places

Four the audit found, all about the stdio client transport, all in `guides/mcp.md`:

- `:4187-4189` says the transport "spawns `options.command` via `node:child_process.spawn(command,
  args, { env, stdio: ['pipe', 'pipe', 'inherit'] })". It constructs `@orkestrel/process`'s `Process`,
  which spawns `['pipe','pipe','pipe']` and retains stderr into a bounded tail. The class doc at
  `src/server/transports/StdioClientTransport.ts:23-24` already says this correctly.
- The same clause says "a provided `env` REPLACES it entirely". **It merges over `process.env`** —
  `StdioClientTransport.ts:86-90` passes `environment` with no `isolated: true`, and
  `mergeEnvironment` layers `[process.env, base, override]` when `isolated` is falsy. This is the one
  to fix first: a consumer writing `env: { TOKEN: 'x' }` believes it isolated the child and has handed
  it the parent's whole environment.
- `:2214-2217` repeats the stderr falsehood in prose.
- `:2776-2785` says transport close "ends the connection and releases resources" as a universal. That
  is now true of the HTTP transports and was not before; check every transport against it and state
  what actually holds.

Four more that `0489f0e` created:

- `:4056-4057` — "when `timeout` is set, each `fetch` call passes `signal: AbortSignal.timeout(timeout)`".
  A signal is now passed with or without a `timeout`, and with one it is
  `AbortSignal.any([close, AbortSignal.timeout(timeout)])`.
- `:4113-4114` — "a request error REJECTS `start()`". A request error caused by this transport's own
  `close()` now resolves it.
- `:4118-4119` — "`close()` closes the socket and fires `close` (idempotent)". It also destroys a
  pending upgrade and unsubscribes from the socket.
- `:2785` — the `close` row of `MCPClientTransportInterface` no longer states the whole contract.
  Idempotence is contract law as of `0489f0e`; `src/core/types.ts` carries the sentence.

**Also document the behaviour this release exists for.** `guides/mcp.md:2203-2271` documents
`createStdioServer` and summarises the handle without saying what `stop()` releases, and the clause
describing the stdio server's pump says nothing about teardown. A consumer cannot learn from the guide
that a closed stdio server lets the process exit, which is what the last three commits were about.

The parity gate checks that every barrel export is documented and no phantom is. It cannot check
whether a sentence is true, which is why all eight passed a green gate. Where a sentence you rewrite
states a behaviour a test could break, add the executed assertion beside it, per
`.claude/rules/documentation.md` § Parity. A `toContain` substring check is a presence guard, not a
proof.

## M8 — `HTTPDisconnect.bridge()` called twice leaks and disarms

`src/server/transports/HTTPDisconnect.ts:95` assigns `this.#timer = setInterval(...)` with no guard. A
second `bridge()` overwrites the handle, so the first interval is unreachable and runs for the
process's life — a ref'd timer, the exact defect class this round is about. It compounds: the first
bridge's terminal calls `#release()`, which aborts `#lifecycle`, so the second bridge's
`addEventListener('abort', …, { signal: this.#lifecycle.signal })` registers against an
already-aborted signal and is never added at all. The second bridge has neither cleanup.

The class doc says "This is a single-response lifecycle object, not a reusable bridge" and nothing
enforces it. `HTTPDisconnect` is exported and its `@example` shows a consumer constructing and
bridging directly. Refuse the second call, matching the idempotence guards every other lifecycle
object here carries.

## M10 — `seen` is never pruned

`src/browser/helpers.ts:136` holds every accepted `MessagePort` for the closure's life, and
`serveMCPScope`'s disposer clears `teardowns` and not `seen`. In a Service Worker — the shape the doc
names — that closure lives as long as the worker, so it retains every client port it ever accepted,
including ones already closed and unbound. The dedup itself is right; what is missing is clearing the
set beside `teardowns`, which needs the set hoisted or a clear passed alongside.

## M12 — nothing proves the published artifact

This package defines no `test:distribution`, while `@orkestrel/process` and `@orkestrel/probe` each
pack themselves, install the tarball into a directory outside the repository, and assert every
`exports` target resolves, both module formats load for every entry, and each entry's runtime export
set equals its `.d.ts` value-declaration set.

The objective lane packed and installed this package by hand and found the artifact **currently
correct**: 18 files, ESM loading 140 core, 19 browser, and 44 server exports, CJS loading 140 and 44,
every runtime export set equal to its declarations, and an added outside-population export made its
parity control fail. So this is a missing gate rather than a live defect — and the next change has
nothing watching it.

Add the gate. Read `@orkestrel/process`'s `tests/distribution.test.ts` and follow its shape rather
than inventing a second one; this package has three faces where that one has two, and the browser face
declares no `require` condition, which is consistent rather than an omission.

Adding a Vitest project means moving `vite.config.ts` and `package.json` together, so both are yours
for this and nothing else.

One asymmetry the lane found that no distribution test would catch: `package.json` declares no root
`types` field while `@orkestrel/websocket` does, so a `moduleResolution: node10` consumer resolving
through `main` gets no types. Rule on it, in the guide's Requirements section if this package has one,
the way `@orkestrel/process` states its `moduleResolution` floor. Report the ruling.

## Not yours

- **M5, the unbind instrument.** Removing both `unbind()` calls reddens nothing across the whole
  `src:server` project — established three ways. Whether that seam should be observable at all is a
  design question the Orchestrator holds. Do not add a test that passes either way, and do not
  redesign the binder.
- **Every transport's code.** `0489f0e` closed those findings and its gates are green. Change none of
  `src/server/transports/`, `src/browser/transports/`, or `src/server/factories.ts`.
- **A count in prose.** A separate sweep deletes those from this package. Do not add one, and do not
  go looking for them.

## Scope

Owned: `guides/mcp.md`, `README.md`, `src/server/transports/HTTPDisconnect.ts`,
`src/browser/helpers.ts`, `tests/guides.test.ts`, `tests/distribution.test.ts` (new),
`tests/src/browser/helpers.test.ts`, the test mirroring `HTTPDisconnect`, plus `vite.config.ts` and
`package.json` for the distribution project alone.

Off-limits: every other file, and in particular all barrels, every transport, `src/server/factories.ts`,
`src/core/types.ts`, `src/server/types.ts`, `src/browser/types.ts`, and every vendored file.

Tools: Read, Grep, Glob, Edit, Write, Bash. No commits, no pushes, no dependency installs, no
destructive command. Never run `git checkout`, `git restore`, `git stash`, `git reset`, or `git clean`.

## Execution

Perform this assignment yourself. Spawn nothing. Write probes as `tmp/probe/<name>.test.ts` and run
them with `npm run test:probe`; delete them before returning.

## Deviation contract

Stop and report — expected, found, evidence, done or not done, one hypothesis at most — when a quoted
line is not where this brief says it is, when a fix needs an off-limits file, or when the distribution
gate cannot be added without changing a barrel or an export.

Decide and carry on, recording the choice: every rewritten sentence, the refusal's error shape, where
`seen` is cleared, and the distribution test's structure.

## Acceptance criteria

Report each bare exit code, in order.

1. Each of the eight false sentences now states what the code does. Quote before and after.
2. `npm run format` then `npm run format:check` exits 0.
3. `npm run lint:check` exits 0.
4. `npm run check` exits 0.
5. M8 and M10 each have a test that fails against the unfixed code. Record the command and both counts.
6. `npm run test:guides` exits 0.
7. `npx vitest run --config vite.config.ts --no-cache --reporter=dot --project src:browser` exits 0.
8. `npm run test:distribution` exits 0, and it fails when you plant an unexported name in the
   expected set. Record both counts.
9. `npm run test:config` exits 0 — it asserts this package's own scripts, so a new one moves it.
10. `npm run test:policy` exits 0.

Do not run `npm test` or `npm run build`. An independent verifier takes those.

## Output

One row per finding with what changed and what proves it; the before-and-after for all eight
sentences; the red-then-green counts for criteria 5 and 8; one row per criterion with its exit code;
the `types` ruling; the decisions you took; and anything you could not close.

No process diary.
