# MFIX-B report

## Outcome

F3, F4, F6, F7, F8, and F9 are implemented. Formatting, lint, TypeScript, the exact prose sweeps,
and the package-owned legacy law pass. The sandbox prevented authoritative runtime readings for
commands that open loopback listeners, spawn a test child, or invoke npm from the test process.
Those commands and their sandbox evidence are under **Observations**.

## Files changed

- `guides/mcp.md` — narrows parity claims to Surface-row and TypeScript-fence checks; points legacy
  membership claims to the package guide suite; documents the bounded stdio client pump and Node's
  unread-stream restoration limit.
- `src/server/transports/StdioClientTransport.ts` — adds a transport-owned pump release barrier,
  races line iteration against release, and awaits pump settlement during close.
- `src/server/transports/StdioServerTransport.ts` — narrows lifecycle TSDoc to flowing versus
  non-flowing preservation and names Node's `readableFlowing === null` limit.
- `tests/distribution.test.ts` — reads the `npm pack --json` inventory, checks it against the
  manifest allowlist plus npm-required metadata, plants a negative control, and classifies export
  failures as manifest, build-output, or packed-inventory defects.
- `tests/guides.test.ts` — executes legacy-owner membership in both directions, plants an added
  owner, enforces the absence of legacy ownership spellings in `MCPServer.ts`, and removes unstable
  positional prose.
- `tests/setupBrowser.ts` — replaces a positional listener reference with a stable description.
- `tests/src/server/transports/StdioClientTransport.test.ts` — drives a real child whose detached
  descendant inherits stdout and requires transport close to settle within its bound.
- `tests/src/server/transports/StdioServerTransport.test.ts` — records the unread
  `readableFlowing` transition and explains the Node limit.
- `tmp/codex/mfixb-report.md` — records this report.

## Rulings

### F3

I chose the bound. It changes no public contract. `close()` resolves a transport-owned release
promise before awaiting the supervisor's bounded `destroy()`, and the line pump races its pending
iterator read against that release. The pump therefore settles even when a descendant retains the
child's stdout pipe. The transport still awaits the pump before emitting `close`.

### F8

I narrowed the guide claim. The package suite intentionally checks Surface rows in both directions
and named imports in TypeScript fences. Arbitrary inline code spans also name host globals, wire
fields, external contracts, and syntax, so treating every span as a package API would expand the
gate beyond its actual contract.

## Acceptance

### Prohibited prose sweep

```text
command: rg -n -i 'six transports|seven findings|eight places|17 rows|the third answer|the second assertion|first expectation' tests/ src/ guides/ README.md
exit: 1
matches: 0
```

The broader case-insensitive review covered number words, ordinals, numeric forms, and their
inflections across `tests/`, `src/`, `guides/`, and `README.md`. Current-scope repairs were in
`tests/guides.test.ts` and `tests/setupBrowser.ts`. The clean control was:

```text
command: rg -n -i '\btwentieth\b' tests/ src/ guides/ README.md
exit: 1
matches: 0
```

External identifiers, protocol revisions, error codes, versions, bounds, durations, sizes, and
runtime sequence descriptions remain.

### Vendored policy sweep and guide ownership

```text
command: rg -n -i 'legacy' tests/policy.test.ts
exit: 1
matches: 0
```

Every MCP guide claim now names `tests/guides.test.ts`, which performs the package-specific checks,
or makes no policy-suite claim. The focused package law reading was:

```text
command: npx vitest run --config vite.config.ts --project guides -t 'legacy server-ingress ownership'
exit: 0
Test Files  1 passed (1)
Tests       3 passed | 129 skipped (132)
```

### Lint

```text
command: npm run lint:check
exit: 0
warnings: 0
errors: 0
```

### TypeScript

```text
command: npm run check
exit: 0
diagnostics: 0
projects: root, src:core, src:browser, src:server
```

### Core project

Authoritative host reading required. The sandbox reading and exact host command are under
**Observations**.

### Guide project

Authoritative host reading required. The sandbox reading and exact host command are under
**Observations**. The listener-free legacy law slice passes as shown above.

## F6 negative control

The test creates its owned path and plant with these exact operations:

```ts
const controlDirectory = mkdtempSync(join(root, 'tmp', 'mcp-distribution-control-'))
const controlFile = join(controlDirectory, 'unexpected.txt')
writeFileSync(controlFile, 'packed inventory negative control\n')
```

It proves the real packed inventory excludes `controlPath`, then appends `controlPath` to that
inventory and requires `findUnexpectedPackedPaths` to return the planted path. The `finally` block
removes the exact owned directory with:

```ts
rmSync(controlDirectory, { recursive: true, force: true })
```

The denied distribution run exercised that `finally` block. This cleanup check returned no path:

```text
command: find tmp -maxdepth 1 -type d -name 'mcp-distribution-control-*' -print
exit: 0
output: empty
```

## Observations

### Core project loopback denial

The brief expected this project to need no listener, but current
`tests/src/core/MCPClient.test.ts` contains real HTTP cases. The sandbox refused
`127.0.0.1` with `listen EPERM`, causing those cases to time out.

```text
host command: npx vitest run --config vite.config.ts --project src:core
sandbox exit: 1
Test Files  1 failed | 13 passed (14)
Tests       2 failed | 717 passed (719)
Errors      2
```

### Guide project child-process denial

The sandbox did not allow the guide test process to obtain reports from its spawned children. The
stdio environment and descriptor cases timed out; every other guide case passed.

```text
host command: npx vitest run --config vite.config.ts --project guides
sandbox exit: 1
Test Files  1 failed (1)
Tests       4 failed | 128 passed (132)
```

### Distribution project npm denial

The test process could not invoke `npm pack`; `spawnSync npm` returned `EPERM`. The inventory and
nested-install reading therefore requires the host.

```text
host command: npx vitest run --config vite.config.ts --project distribution
sandbox exit: 1
Test Files  1 failed (1)
Tests       1 failed (1)
```

### Browser project loopback denial

Vite could not listen on `0.0.0.0:24678`, and the setup listener on `127.0.0.1` also returned
`EPERM`. Collection did not start.

```text
host command: npx vitest run --config vite.config.ts --project src:browser
sandbox exit: 1
test files collected: 0
```

### Server project listener and process denial

Real server cases could not listen on `0.0.0.0` or `127.0.0.1`. Stdio cases that spawn children,
including the descendant-held-pipe proof for F3, could not obtain child reports in this sandbox.

```text
host command: npx vitest run --config vite.config.ts --project src:server
sandbox exit: 1
Test Files  6 failed | 6 passed (12)
Tests       96 failed | 165 passed (261)
Errors      8
```

## Unclosed

The host readings named under **Observations** remain. No source, guide, lint, type, package-law, or
scoped prose finding remains open.