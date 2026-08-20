# M1 — a closed stdio transport must let the process exit

## Role and engine

`sol` (GPT-5.6 Sol), through `codex exec`. Perform the assignment directly and spawn nothing.

## The defect, measured

`StdioServerTransport.close()` sets a flag and emits an event. It removes none of the three listeners
`start()` attached to the input stream, so a closed transport keeps the stream in flowing mode and the
process never exits.

Measured on 2026-08-20 against the published `@orkestrel/mcp` 0.0.19 installed in
`/workspace/probe/node_modules`, driving `createStdioServer(...).start()` then `.stop()`:

```
=== stdin at /dev/null ===
after start: data listeners = 1
stop() returned synchronously; value = undefined
after stop : data listeners = 1
active resources = []
exit: 0

=== stdin an open pipe ===
after start: data listeners = 1
stop() returned synchronously; value = undefined
after stop : data listeners = 1
active resources = ["PipeWrap"]
STILL ALIVE after 1500 ms — the loop is held
exit: 124 (killed by timeout)
```

Two things that measurement settles, and you must not restate either as open:

- **`stop()` returns.** It is synchronous and returns `undefined`. A record elsewhere in this fleet
  says "`createProbeServer(probe).stop()` never returns"; that claim is false and this unit's report
  is what corrects it.
- **The hang depends on what stdin is.** A `/dev/null` stdin ends and unrefs itself, so the process
  exits despite the retained listener. An open pipe or a TTY does not. So a consumer sees this in a
  test harness and an embedder sees it in production; both are real, and neither shows up when stdin
  is closed.

## The repairs

### 1. `close()` releases what `start()` acquired

`src/server/transports/StdioServerTransport.ts:71-76` subscribes with three inline arrow functions, so
no reference survives for removal. Retain them, and remove all three when the transport closes.

`close()` at `:82-86` and `#onClose()` at `:99-104` are the same two statements plus the emit. They are
both close paths and both must release. Route them through one private release step rather than
repeating the removal.

`#onClose()` fires from the input's own `close` event, so releasing inside it removes a listener while
that event is dispatching. Confirm Node permits that here rather than assuming it: removing a listener
during emit is defined, but removing the listener currently executing is the case to check.

### 2. `createStdioServer` discards the unbind function

`bindServer` returns a function that tears down the bridge's own emitter subscriptions, and
`createStdioServer` throws it away. Find it in `src/server/` and hold it, so `stop()` releases the
bridge as well as the stream. If the discard is deliberate, say why and leave it — but say so
explicitly rather than silently.

### 3. What must not change

The injected streams are caller-owned. The class documents that they must never be closed out from
under the process, and that contract stands: do not call `destroy()`, `pause()`, `end()`, or
`removeAllListeners()` on `#input`. Remove exactly the handlers this class added.

`start()` is idempotent and must stay so. `close()` is idempotent and must stay so. A `start()` after a
`close()` is currently refused by the `#closed` guard at `:71`; keep that behaviour and prove it.

## Standing conditions

- The tree is clean at the commit the dispatch names **except for `tmp/`**, which holds this brief's staged copy and your own journal and is expected to be dirty. `.gitignore` covers it. Do not treat `tmp/` as a deviation.
- The version is 0.0.19, matching the registry.
- Do not bump the version. The Orchestrator sequences the release.
- Do not edit any file under `.agents/`, `.claude/`, or `configs/`. Those are vendored by `@orkestrel/scaffold` and `repair` reverts an edit there.
- A bench sandbox denies a grandchild process and a nested `npm install`. If any gate needs either, record it as an observation naming the exact settling command; the Orchestrator takes that run on the host.

## Scope

**Owned:** `src/server/transports/StdioServerTransport.ts`, the `createStdioServer` factory file, their
mirrored test files under `tests/src/server/`, and `guides/mcp.md` only where a sentence about
`stop()`'s teardown becomes false.

**Off-limits:** everything else, including `package.json`, every other transport, every vendored path,
and every file in `.orkestrel/`.

**Tools:** read, write, and run commands inside `/workspace/mcp`. Do not commit, push, install a
dependency, or run a destructive command.

## Execution

Perform this assignment directly. Spawn nothing.

Insert a failing proof before the fix: a test that starts the transport over a stream that stays open,
closes it, and asserts the listener count returns to what it was before `start()`. Record the command
and its failing count, implement, then record the same command green.

The listener-count assertion is the right shape because it is what the measurement above reads, and it
fails for the right reason. A test that asserts "the process exits" needs a child process and cannot
run in a bench sandbox; do not write that one here — name it as the settling proof and let the
Orchestrator take it on the host.

## Acceptance criteria

Ordered so an unreachable criterion cannot hide the ones behind it.

1. After `close()`, the input stream carries exactly the listeners it carried before `start()`, proven by a test that fails against the current source.
2. Both close paths release: a transport closed by `close()` and a transport closed by its input's own `close` event both end with the listeners removed.
3. `start()` after `close()` stays refused, and `close()` twice stays a no-op, both proven.
4. `#input` is never destroyed, paused, ended, or blanket-cleared. State how you verified this.
5. The `createStdioServer` unbind is either called or explicitly ruled deliberate with its reason.
6. `npm run format:check`, `npm run lint:check`, and `npm run check` each exit 0. These are criteria.
7. `npm run build` and `npm test`: run them, record the bare exit code, and treat the result as an **observation**.

## Deviation contract

A conflict with the objective stops the unit: report expected, found, exact evidence, done or not done,
and at most one short hypothesis. A gate that fails on `EPERM` or a denied nested operation is not a
deviation; record it as criterion 7 asks and carry on.

## Output

- The repair, with the `file:line` for each change.
- The red-then-green command and both counts.
- Your finding on the `createStdioServer` unbind.
- How you verified criterion 4.
- The gate table: command, bare exit code, criterion or observation.
- Files changed.

No process diary.
