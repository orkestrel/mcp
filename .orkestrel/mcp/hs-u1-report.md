# HS-U1 report

## Changes

1. **Probe deadline law.** `src/core/constants.ts:167`-`181` now defines only the ordinary client request deadline. `src/core/MCPClient.ts:98`-`104` states that discovery uses the configured request deadline. `src/core/MCPClient.ts:308`-`314` passes `this.#timeout` to the discovery request. `src/core/types.ts:2482`-`2489` states the same contract. The only `#probe` consumer was `discover()` at the former `src/core/MCPClient.ts:310`; it now receives `this.#timeout`. `rg -n "DEFAULT_MCP_PROBE_TIMEOUT|#probe" src/` exited 1 with no output.
2. **Construction pin refusal.** `src/core/MCPClient.ts:204`-`231` reads `options.version` once, validates it before emitter construction and transport subscription, and throws `MCPError` code `MCP_UNSUPPORTED_VERSION` with `{ supported: SUPPORTED_PROTOCOL_VERSIONS, requested }`. `src/core/types.ts:2240`-`2245` documents the exact-pin and synchronous-construction contract. `src/core/errors.ts:1`-`12` states that `MCPError` also reports locally detected protocol incompatibility.
3. **Exact modern pin.** `src/core/MCPClient.ts:713`-`727` selects the pin itself only when the validated discovery revisions contain it. An absent pin produces `MCPError` code `MCP_UNSUPPORTED_VERSION` with `{ supported, requested }`; the pinned path does not enter legacy fallback.
4. **Exact legacy pin.** `src/core/MCPClient.ts:882`-`897` validates the returned legacy revision, then rejects a mismatch with `MCPError` code `MCP_UNSUPPORTED_VERSION` and `{ requested, negotiated }` before `notifications/initialized` and before connection state installation.
5. **Behavioral proofs.** `tests/src/core/MCPClient.test.ts:592`-`610` crosses an `unknown` boundary through `Reflect.apply` and proves synchronous invalid-pin refusal. `tests/src/core/MCPClient.test.ts:679`-`697` proves legacy mismatch refusal and no initialized notification. `tests/src/core/MCPClient.test.ts:802`-`820` proves modern discovery must advertise the exact pin. `tests/src/core/MCPClient.test.ts:1164`-`1184` records the deadline passed to the real `AbortSignal.timeout` implementation and proves that negotiation receives `15_000`, with `14_999` as the recorder control. The former source-text assertions and their `readFileSync` import are removed. The silent-peer proof at `tests/src/core/MCPClient.test.ts:1100`-`1115` uses a 30ms real deadline so the suite does not wait 5 seconds under the no-cap law.

## Red and green readings

The pre-fix targeted run collected all four new proofs and exited 1:

```text
Test Files  1 failed (1)
Tests  4 failed | 131 skipped (135)
```

- Invalid runtime pin: `isMCPError(failure)` was `false` instead of `true`.
- Legacy pin mismatch: `connect()` resolved instead of rejecting.
- Modern pin mismatch: `connect()` resolved instead of rejecting.
- Probe deadline: the recorder read `[14999, 50]` instead of `[14999, 15000]`.

The same targeted run after the implementation exited 0:

```text
Test Files  1 passed (1)
Tests  4 passed | 131 skipped (135)
```

The complete in-process population of the owned file exited 0:

```text
Test Files  1 passed (1)
Tests  133 passed | 2 skipped (135)
```

The filter skipped only the 2 existing tests that bind an HTTP fixture to `127.0.0.1`. An unfiltered attempt collected 133 passing tests, then those 2 tests failed because this sandbox refused `listen(127.0.0.1)` with `EPERM` and each reached the 5-second test timeout.

## Gates

- `npm run lint:check`: exit 0.
- `npm run check`: exit 0, including root, core, browser, and server TypeScript projects.
- `npm run format:check`: exit 0; 201 files matched.
- `git diff --check`: exit 0.
- No owned test assertion reads `MCPClient.ts` source text.

## Working tree evidence

`git diff --stat`:

```text
 src/core/MCPClient.ts            |  47 ++++++++++++-----
 src/core/constants.ts            |   3 --
 src/core/errors.ts               |  16 +++---
 src/core/types.ts                |   8 ++-
 tests/src/core/MCPClient.test.ts | 108 ++++++++++++++++++++++++++++++++++-----
 5 files changed, 143 insertions(+), 39 deletions(-)
```

`git status --short`:

```text
 M src/core/MCPClient.ts
 M src/core/constants.ts
 M src/core/errors.ts
 M src/core/types.ts
 M tests/src/core/MCPClient.test.ts
```
