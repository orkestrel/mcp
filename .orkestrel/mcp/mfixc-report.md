# MFIX-C report

The owned fixes are implemented. Formatting, lint, and TypeScript checks pass. The sandbox blocked the packed-artifact assertions, the browser regression collection, and the process-spawning guide rows, so those host proofs remain open.

## Files touched

The owned files changed as follows.

- `tests/distribution.test.ts` creates the packed-inventory control at the package root, inside the cleanup `try` block. The control is outside the `files` allowlist without relying on gitignore, and cleanup handles construction failure without leaking either scratch directory.
- `tests/guides.test.ts` recognizes a named `MCPLegacy` or `MCPSession` import from any specifier. Its control imports `MCPLegacy` from `@src/core`, outside the earlier relative-specifier population.
- `guides/mcp.md` states that the executed legacy-owner list lives in the suite, documents resolved browser close-before-open settlement, puts stdio line-pump release before bounded supervisor teardown, records the consequence and remedy for a stream left at `readableFlowing === false`, and fixes the ambiguous client/transport sentence and the bare `close` token.
- `src/browser/transports/WebSocketClientTransport.ts` captures and calls the pending resolver after the `close` event instead of rejecting the pending `start()` call. Its class documentation states the same settlement rule.
- `tests/src/browser/transports/WebSocketClientTransport.test.ts` expects resolved settlement and bounds the assertion with `waitForSettlement`, so omitting settlement produces a timeout failure instead of a hung test.
- `src/server/transports/StdioClientTransport.ts` states the implemented cleanup order in its class documentation: release the line pump, then run bounded process-group termination and supervisor teardown.
- `src/server/transports/StdioServerTransport.ts` states that a later `data` listener does not resume a stream left non-flowing and that the caller must call `resume()`.
- `tmp/codex/mfixc-report.md` contains this report.

The pre-existing untracked `.orkestrel/mcp/mcp-audit2-brief.md` file remains untouched.

## Clean-checkout distribution reading

The clean-checkout sequence produced these readings.

```text
test ! -e /tmp/mfixc-tmp-hold
exit 0

mv tmp /tmp/mfixc-tmp-hold
exit 0

npm run test:distribution
exit 1
Test Files 1 failed (1)
Tests 1 failed (1)
```

With `tmp/` absent, the test created its package-root control and reached `npm pack`. It did not throw `ENOENT`. The sandbox then refused the child process as `spawnSync npm EPERM` at `tests/distribution.test.ts:147`, before the packed-inventory assertions.

The restoration sequence produced these readings.

```text
mv /tmp/mfixc-tmp-hold tmp
exit 0

test -f tmp/codex/mfixc-brief.md && test -z "$(find . -maxdepth 1 -type d -name 'mcp-distribution-control-*' -print -quit)"
exit 0
```

The brief directory is restored, and no package-root control directory remains.

## Legacy-ownership instrument

The membership rule covers a `src/` module that declares the legacy entities or their owned contracts, exports their factory or barrel, or imports a named `MCPLegacy` or `MCPSession` binding from any specifier. The word boundary excludes `MCPLegacyResult`.

The control is planted only in the in-memory inventory copy with these statements:

```ts
const controlPath = 'src/core/LegacyControl.ts'
const control = {
	...files,
	[controlPath]: "import { MCPLegacy } from '@src/core'\n",
}
```

No filesystem module is created. The control is removed when the test callback releases the local inventory copy.

With the earlier relative-specifier pattern and that control planted, the reading was:

```text
npx vitest run --config vite.config.ts --project guides --testNamePattern 'reports a planted owner outside the guide membership'
exit 1
Test Files 1 failed (1)
Tests 1 failed | 131 skipped (132)
```

The received owner set omitted `src/core/LegacyControl.ts`, so the earlier pattern did not detect the `@src/core` binding.

With the specifier constraint removed and the same control planted, the reading was:

```text
npx vitest run --config vite.config.ts --project guides --testNamePattern 'reports a planted owner outside the guide membership'
exit 0
Test Files 1 passed (1)
Tests 1 passed | 131 skipped (132)
```

The corrected pattern detects the planted module, and the control assertion reports the widened class distinctly.

### Guide reconciliation ruling

The guide sentence is narrowed. The suite owns the executed legacy-owner list and compares that list with the tree in both directions. The guide owns a descriptive module list. The guide no longer claims that editing its descriptive list alone fails the suite; it directs a developer to update both representations in the same change.

## Verified stdin behavior

The behavior was measured before the documentation changed with this command:

```text
node --input-type=module -e "import { Readable } from 'node:stream'; const input = Readable.from(['payload']); input.pause(); let delivered = false; input.on('data', () => { delivered = true }); await new Promise((resolve) => setImmediate(resolve)); console.log(JSON.stringify({ phase: 'listener', flowing: input.readableFlowing, delivered })); input.resume(); await new Promise((resolve) => input.once('end', resolve)); console.log(JSON.stringify({ phase: 'resume', flowing: input.readableFlowing, delivered }))"
exit 0
{"phase":"listener","flowing":false,"delivered":false}
{"phase":"resume","flowing":true,"delivered":true}
```

A stream paused at `false` stayed non-flowing and delivered nothing after a `data` listener was attached. The stream delivered after `resume()`.

## Acceptance evidence

Each acceptance criterion has the following reading.

### Distribution without `tmp/`

`npm run test:distribution` exited 1. It passed the former failure point, created the package-root control, and reached `npm pack`; the sandbox denied that child process with `EPERM`. The `tmp/` directory was restored, and the control directory was cleaned. The exact file and test counts are in the clean-checkout reading.

### Legacy-owner outside-population control

The earlier-pattern reading exited 1, and the corrected-pattern reading exited 0. Both runs collected the same named control test; the exact counts are in the legacy-ownership instrument readings.

### Browser and Node close-before-open settlement

The following search exited 0:

```text
rg -n 'reject' src/browser/transports/WebSocketClientTransport.ts
```

Its matches are the ordinary handshake-failure path and declarations supporting that path. The `close()` method contains no rejection and calls `resolve?.()` after emitting `close`. The unchanged Node face resolves its destroyed in-flight upgrade request, and its regression test bare-awaits the pending `start()` call.

The rewritten browser regression command exited 1 before collection because the sandbox denied Vite's listener on `0.0.0.0:24678` and the fixture listener on `127.0.0.1`. No test count was produced.

For the required mutation, the `resolve?.()` line was removed, the same browser command was run, and the exact line was restored. The sandbox denied collection again, so the mutation did not produce the required red test reading here. The bounded assertion will report `Timed out waiting for close to settle the pending start` when the host runs it with settlement omitted.

### Lint

```text
npm run lint:check
exit 0
```

Oxlint emitted no warning or error count.

### TypeScript and environment checks

```text
npm run check
exit 0
```

The root, core, browser, and server TypeScript checks completed. The commands emitted no diagnostic count.

### Guide project

```text
npx vitest run --config vite.config.ts --project guides
exit 1
Test Files 1 failed (1)
Tests 4 failed | 128 passed (132)
```

The failing rows are the process-spawning stdio guide proofs. Each timed out at 5000 ms under the stated sandbox restriction. The legacy-owner control and the remaining guide rows passed.

### Supplemental format gate

```text
npm run format:check
exit 0
201 files checked
```

## Observations

The sandbox denied these readings. Run the named commands on the host.

- The clean-checkout distribution run reached `npm pack` and failed with `spawnSync npm EPERM`. Move `tmp/` aside, run `npm run test:distribution`, and restore `tmp/` afterwards.
- The browser settlement and mutation run could not start its real browser fixture. Run `npx vitest run --config vite.config.ts --project src:browser tests/src/browser/transports/WebSocketClientTransport.test.ts --testNamePattern 'close settles a start whose handshake has not opened'`. For the mutation reading, remove only `resolve?.()` from the browser transport's `close()` method, run that command, and restore the exact line.
- The full guide project timed out in its existing process-spawning stdio rows. Run `npx vitest run --config vite.config.ts --project guides` on the host.

## Not closed in this sandbox

The packed-inventory assertions did not run because the sandbox denied `npm pack`. The browser settlement regression and its mutation did not collect because the sandbox denied both listeners. The full guide project did not reach green because the sandbox blocked the descendant process behavior used by its stdio rows. No owned code or test was changed to accommodate those restrictions.