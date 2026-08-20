# MFIX-A report

## Files touched

- `src/browser/transports/MessagePortTransport.ts` — retained the `message` and `messageerror` listeners as bound readonly fields. `close()` now removes them, clears the registered message and closed callbacks, closes the port, and invokes the saved closed callback.
- `src/browser/transports/WebSocketClientTransport.ts` — retained the pending handshake socket, open/error listeners, resolver, and rejector. Handshake settlement now removes its temporary listeners. `close()` removes them and rejects a pending `start()` with a closure-specific error.
- `tests/src/browser/factories.test.ts` — added the permanent `MessagePortTransport` regression proof using a real `MessageChannel` and direct native event dispatch after closure.
- `tests/src/browser/transports/WebSocketClientTransport.test.ts` — added the permanent close-before-open regression proof. Under the browser project it uses the injected real in-process WebSocket server.

`src/server/transports/WebSocketClientTransport.ts` did not change. It already retains the in-flight `ClientRequest`, destroys it in `close()`, and resolves the pending handshake through the request error handler when closure caused the error. `src/browser/types.ts` and `src/server/types.ts` did not require changes.

The pre-existing `.orkestrel/mcp/mcp-audit-brief.md` and `.orkestrel/mcp/mcp-audit-verdict.md` worktree changes were not touched.

## Red then green

The sandbox denied the browser project's loopback listeners before collection. A temporary Node-only Vitest config ran the same permanent tests against the real host APIs and was removed after the readings.

### F1 — MessagePort listener release

Red:

```text
command: npx vitest run --config tmp/codex/mfixa.vite.config.ts tests/src/browser/factories.test.ts -t "close detaches its port listeners and clears registered callbacks"
exit: 1
Test Files  1 failed (1)
Tests       1 failed | 34 skipped (35)
failure: expected ["after close"] to deeply equal []
```

Green:

```text
command: npx vitest run --config tmp/codex/mfixa.vite.config.ts tests/src/browser/factories.test.ts -t "close detaches its port listeners and clears registered callbacks"
exit: 0
Test Files  1 passed (1)
Tests       1 passed | 34 skipped (35)
```

### F2 — browser WebSocket close-before-open settlement

Red:

```text
command: npx vitest run --config tmp/codex/mfixa.vite.config.ts tests/src/browser/transports/WebSocketClientTransport.test.ts -t "close rejects a start whose handshake has not opened"
exit: 1
Test Files  1 failed (1)
Tests       1 failed | 2 skipped (3)
expected: WebSocket transport closed before connection opened
received: WebSocket connection failed
```

Green:

```text
command: npx vitest run --config tmp/codex/mfixa.vite.config.ts tests/src/browser/transports/WebSocketClientTransport.test.ts -t "close rejects a start whose handshake has not opened"
exit: 0
Test Files  1 passed (1)
Tests       1 passed | 2 skipped (3)
```

## Acceptance criteria

### Lint

```text
command: npm run lint:check
exit: 0
```

### Type checks

```text
command: npm run check
exit: 0
```

### Browser project

```text
command: npx vitest run --config vite.config.ts --project src:browser
exit: 1
collection: none
error: listen EPERM: operation not permitted 0.0.0.0:24678
error: listen EPERM: operation not permitted 127.0.0.1
```

### Server project

```text
command: npx vitest run --config vite.config.ts --project src:server
exit: 1
Test Files  6 failed | 6 passed (12)
Tests       95 failed | 165 passed (260)
Errors      8
common failure: listen EPERM: operation not permitted 0.0.0.0 or 127.0.0.1
```

The server failures and timeouts followed denied loopback binds. They do not identify a source failure in this unit.

## F2 settle ruling

Close-before-open rejects. Resolving would report that the transport opened successfully. Reusing the handshake-failure rejection would hide whether the peer failed or the caller closed. The distinct `WebSocket transport closed before connection opened` rejection preserves that distinction while settling the pending `start()` immediately.

## Guide replacement

None. The guide's release and settlement statements remain true.

## Not closed

The authoritative browser and server project gates could not pass because the sandbox forbids their required loopback listeners. The permanent browser WebSocket proof therefore could not be executed against its injected real in-process server in this environment. No whole-suite run was taken.