# M1fix — removing the listener is necessary and not sufficient

## Role and engine

`sol` (GPT-5.6 Sol), through `codex exec`. Perform the assignment directly and spawn nothing.

## What M1 did, and what it did not

M1 landed correctly against every criterion its brief set. The three handlers are retained and removed,
both close paths release, `start()` after `close()` stays refused, and the `bindServer` unbind is now
called. Its scoped test proves the listener count returns to baseline.

The listener count was the wrong criterion. **The goal was that a closed transport lets the process
exit, and it still does not.** Measured on 2026-08-20 against this tree's built output, with an open
stdin pipe:

```
data listeners  before=0 during=1 after=0        <- M1's repair works
active resources = ["PipeWrap"]
FAIL: still alive after 1500 ms — the loop is held
```

The published 0.0.19 control, same probe, shows the difference M1 made and the part it did not reach:

```
data listeners  before=0 during=1 after=1        <- the leak M1 closed
active resources = ["PipeWrap"]
```

So the repair is real and the defect survives it.

## Why

`readable.on('data')` puts a stream into flowing mode and refs its handle. `removeListener` takes the
handler off; it does not undo the flow. Isolated on a bare stream, all three teardowns measured:

```
remove              -> ["PipeWrap"]  STILL ALIVE
remove + pause()    -> ["PipeWrap"]  process exited
remove + unref()    -> []            process exited
```

`pause()` releases the loop while leaving the handle in the resource list; `unref()` also clears it
from the list. Either lets the process exit. Removing the listener alone does not.

## The correction to M1's brief

M1's brief said: *do not call `destroy()`, `pause()`, `end()`, or `removeAllListeners()` on `#input`.*
**The `pause()` half of that instruction was wrong, and this brief withdraws it.** The reasoning behind
the ban stands for the other three — a caller-owned stream must not be closed or emptied out from under
the process — but `pause()` closes nothing. It reverses exactly the state change `on('data')` made, and
a caller who wants to read again resumes or attaches a listener. Undoing your own side effect is
release, not seizure.

`destroy()`, `end()`, and `removeAllListeners()` remain forbidden.

## The repair

After removing the three handlers, pause the input — **but only when this transport is what started the
flow.** A caller who had the stream flowing before `start()` must still have it flowing after `close()`;
pausing it then would starve a consumer this transport never owned.

Read `input.listenerCount('data')` immediately before attaching. Zero means this transport caused the
flow and owns undoing it. Non-zero means someone else is reading, and the transport removes its own
handlers and pauses nothing.

Prefer `pause()` to `unref()`: `unref()` is not defined on every readable, and the difference between
them here is only whether the handle stays listed, not whether the loop drains.

## Standing conditions

- The tree is clean at the commit the dispatch names, except `tmp/`, which is gitignored and expected to be dirty. Do not treat `tmp/` as a deviation.
- The version is 0.0.19, matching the registry. Do not bump it.
- Do not edit any file under `.agents/`, `.claude/`, or `configs/`.
- `npm test` passes on the host; inside a bench sandbox it fails with `EPERM` binding `0.0.0.0:24678`. That failure is the sandbox, not your change. Record the gate as an observation.
- A test that asserts a process exits needs a child process, which a bench sandbox denies. Do not write that one here; name it as the settling proof and the Orchestrator takes it on the host.

## Scope

**Owned:** `src/server/transports/StdioServerTransport.ts` and
`tests/src/server/transports/StdioServerTransport.test.ts`.

**Off-limits:** everything else, including `src/server/factories.ts`, which M1 already corrected.

**Tools:** read, write, and run commands inside `/workspace/mcp`. Do not commit, push, install a
dependency, or run a destructive command.

## Execution

Perform this assignment directly. Spawn nothing.

Insert a failing proof before the fix. The in-process shape available to you: attach a data listener to
a `PassThrough`, note that it is flowing, close the transport, and assert the stream is no longer
flowing — `readable.readableFlowing` is `false` after a pause and `true` while flowing. Record the
command and its failing count, implement, then record the same command green.

## Acceptance criteria

Ordered so an unreachable criterion cannot hide the ones behind it.

1. A transport that started the flow leaves the input not flowing after close, proven by a test that fails against the current source.
2. A transport handed an already-flowing input leaves it flowing after close, and removes only its own handlers. This is the control that makes criterion 1 worth reading.
3. Nothing calls `destroy()`, `end()`, or `removeAllListeners()` on the input. State how you verified it.
4. `npm run format:check`, `npm run lint:check`, and `npm run check` each exit 0. Criteria.
5. `npm run build` and `npm test`: run them, record the bare exit code, observation.

## Deviation contract

A conflict with the objective stops the unit. A gate failing on `EPERM` or a denied nested operation is
not a deviation.

## Output

- The repair, with `file:line`.
- The red-then-green command and both counts.
- How you verified criterion 3.
- The gate table: command, bare exit code, criterion or observation.
- Files changed.

No process diary.
