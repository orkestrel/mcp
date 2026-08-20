# HS-U2 report

The modern dispatcher separates version-less requests by registry membership before parsing modern metadata.

## Item 1: Refusal split

- `src/core/MCPServer.ts:377` applies the `isModernRequest` guard before the `parseRequestContext` parser.
- `src/core/MCPServer.ts:378` reads the method registry for a request with no modern version declaration. An unregistered method returns `-32601 Method not found: <method>` at `src/core/MCPServer.ts:379`. A registered method returns `-32602 Invalid params: request declares no protocol version` at `src/core/MCPServer.ts:381`.
- `src/core/MCPServer.ts:387` retains `parseRequestContext` for requests that carry the version key. Failing grammar retains `-32602 Invalid params: malformed modern request metadata` at `src/core/MCPServer.ts:391`. A well-formed unsupported revision retains `MCP_UNSUPPORTED_VERSION` with `{ supported, requested }` at `src/core/MCPServer.ts:398`.
- The registry read does not invert the dispatcher invariant. `MCPMethodManager.method` is a `Map.get` lookup with no mutation or handler call, and notification silence remains ahead of `#modern` in `#dispatch`.

## Item 2: Proofs

- `tests/src/core/MCPServer.test.ts:718` proves that bare `createMCPServer` dispatch and handle calls answer legacy-shaped `initialize` with `-32601 Method not found: initialize`.
- `tests/src/core/MCPServer.test.ts:734` proves that a registered `tools/list` request with no version declaration answers `-32602` and names the absent declaration.
- `tests/src/core/MCPServer.test.ts:775` pins the malformed-metadata message when the version key is present but the metadata grammar fails.
- `tests/src/core/MCPServer.test.ts:810` retains the unsupported-version proof with exact `supported` and `requested` data.
- The final owned-file run includes the existing notification-silence assertions and passes all 211 tests.

## Refusal-site sweep

- `src/core/MCPServer.ts:391` changed through the structural branch added before this refusal. The former site received both absent and malformed declarations; it now receives only version-key-present requests whose metadata grammar fails.
- `src/server/handlers.ts:96` remains unchanged. Its malformed-metadata refusal is already guarded by `era === 'modern'`, where `era` comes from `isModernRequest`. A request with no version key cannot reach that refusal. The handler therefore has no sibling absent-declaration misrouting to repair.

## Red and green evidence

The regression command was:

```text
npm run test:src:core -- tests/src/core/MCPServer.test.ts
```

Before the implementation, the result was:

```text
Test Files  1 failed (1)
Tests  2 failed | 209 passed (211)
```

After the implementation, the result was:

```text
Test Files  1 passed (1)
Tests  211 passed (211)
```

The unchanged HTTP refusal site also passed its 2 in-process tests:

```text
Test Files  1 passed (1)
Tests  2 passed | 25 skipped (27)
```

A supplemental full `tests/src/server/handlers.test.ts` run reached 26 passing tests. Its unrelated live-listener test could not bind `0.0.0.0` in the sandbox and failed with `listen EPERM`, consistent with the brief's in-process-only condition.

## Acceptance evidence

- `npm run lint:check`: exit 0.
- `npm run check`: exit 0 for the root, core, browser, and server TypeScript projects.
- `npm run format:check`: exit 0; all matched files use the correct format.
- `rg -n -i 'legacy|MCPLegacy' src/core/MCPServer.ts`: no matches.
- `git diff --check`: exit 0.

## Review evidence

`git diff --stat`:

```text
 src/core/MCPServer.ts            | 12 ++++++++++++
 tests/src/core/MCPServer.test.ts | 37 +++++++++++++++++++++++++++++++++++++
 2 files changed, 49 insertions(+)
```

`git status --short`:

```text
 M src/core/MCPServer.ts
 M tests/src/core/MCPServer.test.ts
```
