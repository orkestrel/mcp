# Process

> A typed child-process toolkit in tiers. `Process` supervises one child with framed stdout
> lines under a bounded backlog, a byte-bounded stderr tail, a live `stderr` event, a writable stdin
> channel, a typed lifecycle emitter, and bounded termination. `execute` and `executeSync` buffer a
> child to completion and settle with an `ExecuteResult`; `detach` is the fire-and-forget spawn that
> returns without waiting. `ProcessManager` is a keyed registry of live children, launched and
> stopped by id and observed through its own emitter. No spawn in this package uses an implicit
> shell, and an argument a batch target could corrupt is refused rather than passed, so a
> metacharacter in an argument is data rather than syntax. The host-independent contracts, errors,
> constants, and types ship from `@orkestrel/process`. The Node implementations and Node-side
> contracts ship from `@orkestrel/process/server`.
>
> Source: [`src/core`](../src/core) (the contracts) and [`src/server`](../src/server) (the Node
> engine).

## Surface

Spawn a supervised child from `@orkestrel/process/server`, read its framed lines, and await its exit:

```ts
import { createProcess } from '@orkestrel/process/server'

const child = createProcess({
	command: { file: 'node', arguments: ['-e', 'console.log("ready"); console.log("done")'] },
	workspace: process.cwd(),
})

const lines: string[] = []
for await (const line of child.lines) lines.push(line)
lines // ['ready', 'done']

const exit = await child.exit
exit.code // 0
await child.destroy()
```

The tiers divide by lifetime. Reach for `Process` when you need the live stream, the stdin
channel, or the lifecycle events. Reach for `execute` or `executeSync` when you want the buffered
output and the exit in one call. Reach for `ProcessManager` when you supervise several children by
id.

### Factories

The interface-oriented constructors, from `@orkestrel/process/server`.

| API                    | Kind     | Summary                                                       |
| ---------------------- | -------- | ------------------------------------------------------------- |
| `createProcess`        | function | Spawn one supervised child and return its `ProcessInterface`. |
| `createProcessManager` | function | Construct an empty `ProcessManagerInterface` registry.        |

### Spawns

The one-shot and fire-and-forget spawns, from `@orkestrel/process/server`.

| API           | Kind     | Summary                                                                         |
| ------------- | -------- | ------------------------------------------------------------------------------- |
| `execute`     | function | Run a command to completion, buffer its output, and resolve an `ExecuteResult`. |
| `executeSync` | function | The blocking counterpart of `execute`, returning the `ExecuteResult` directly.  |
| `detach`      | function | Spawn a command detached with no stdio and return without waiting for it.       |

### Entities

The classes each factory constructs, from `@orkestrel/process/server`, and the error type from
`@orkestrel/process`.

| API              | Kind  | Summary                                                                 |
| ---------------- | ----- | ----------------------------------------------------------------------- |
| `Process`        | class | The supervised child engine — framed lines under a bounded backlog.     |
| `ProcessManager` | class | The keyed registry of live children with auto-eviction on exit.         |
| `ProcessError`   | class | A child-process failure with a stable machine-readable `code`.          |
| `Retention`      | class | The bounded stream-head accumulator with delivered and retained totals. |

### Guards

The total guard, from `@orkestrel/process`.

| API              | Kind     | Summary                                                          |
| ---------------- | -------- | ---------------------------------------------------------------- |
| `isProcessError` | function | Total guard narrowing an unknown caught value to `ProcessError`. |

### Error factories

The constructors for each failure category, from `@orkestrel/process`.

| API                    | Kind     | Summary                                                                   |
| ---------------------- | -------- | ------------------------------------------------------------------------- |
| `createDuplicateError` | function | The `duplicate`-coded failure a registry raises on a reused live id.      |
| `createProtocolError`  | function | The `protocol`-coded failure a launch raises on a destroyed registry.     |
| `createInvalidError`   | function | The `invalid`-coded failure a refused public input raises before a spawn. |
| `createExecuteError`   | function | The failure a rejecting run raises, carrying its `ExecuteResult`.         |

### Command helpers

The resolution and environment building blocks every spawn composes, from
`@orkestrel/process/server`.

| API                         | Kind     | Summary                                                                   |
| --------------------------- | -------- | ------------------------------------------------------------------------- |
| `snapshotCommand`           | function | Take one owned frozen snapshot of a caller's command before validation.   |
| `formatCommand`             | function | Render a `ProcessCommand` into its space-joined diagnostic command line.  |
| `quoteArgument`             | function | Quote one token for a `cmd.exe` command line, doubling an embedded quote. |
| `buildSpawn`                | function | Resolve one command into the file, argument vector, and verbatim flag.    |
| `buildPlatformSpawn`        | function | Build a spawn form from a resolved file and an explicit platform.         |
| `buildExecutableCandidates` | function | Build the ordered paths an explicit platform would search.                |
| `resolveExecutable`         | function | Resolve a command file the way Windows would, or `undefined` on POSIX.    |
| `isFile`                    | function | Report whether a path resolves to a regular file, never throwing.         |
| `readVariable`              | function | Read one environment variable the way the host resolves its name.         |
| `readPlatformVariable`      | function | Read one variable under an explicit platform's key rules.                 |
| `mergeEnvironment`          | function | Merge environment overrides into the environment one child receives.      |
| `mergePlatformEnvironment`  | function | Merge explicit environment layers under one platform's key rules.         |

### Retention helpers

The byte-bounding and result-assembly building blocks, from `@orkestrel/process/server`.

| API                  | Kind     | Summary                                                                     |
| -------------------- | -------- | --------------------------------------------------------------------------- |
| `trimHead`           | function | Keep at most `limit` leading bytes without splitting a UTF-8 sequence.      |
| `trimTail`           | function | Keep at most `limit` trailing bytes without splitting a UTF-8 sequence.     |
| `buildExecuteResult` | function | Assemble one frozen `ExecuteResult` from captured bytes and terminal facts. |

### Termination helpers

The signalling and confirmation building blocks a bounded stop composes, from
`@orkestrel/process/server`.

| API           | Kind     | Summary                                                                   |
| ------------- | -------- | ------------------------------------------------------------------------- |
| `isExited`    | function | Report whether a child has reached its native exit.                       |
| `killProcess` | function | Signal one child, or its detached process group on a POSIX host.          |
| `killTree`    | function | End one Windows process tree through `taskkill`, bounded by a deadline.   |
| `waitForExit` | function | Await one child's native exit, bounded by a deadline.                     |
| `stopChild`   | function | Terminate one child tree and report whether its native exit was observed. |

### Validators

The input refusals every public entry point runs before it spawns anything, from
`@orkestrel/process/server`.

| API                   | Kind     | Summary                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------ |
| `validateText`        | function | Refuse a spawn-bound string that is empty when required or carries NUL.        |
| `validateTimer`       | function | Refuse a timer option outside `[0, PROCESS_TIMER]` or not a whole millisecond. |
| `validateBytes`       | function | Refuse a byte option below its minimum or not a safe integer.                  |
| `validateEnvironment` | function | Refuse an environment override whose name is empty or whose text carries NUL.  |
| `validateCommand`     | function | Refuse a command whose file, arguments, or environment carry bad text.         |
| `validateWorkspace`   | function | Refuse a working directory that is empty or carries NUL.                       |

### Constants

The defaults and host bounds, from `@orkestrel/process`.

| API                    | Kind  | Value                   | Summary                                                             |
| ---------------------- | ----- | ----------------------- | ------------------------------------------------------------------- |
| `PROCESS_GRACE`        | const | `5_000`                 | Default POSIX milliseconds between `SIGTERM` and `SIGKILL`.         |
| `PROCESS_CONFIRMATION` | const | `5_000`                 | Milliseconds a termination waits for the native exit after a kill.  |
| `PROCESS_EVIDENCE`     | const | `2_048`                 | Default maximum retained stderr tail, in bytes, for a `Process`.    |
| `PROCESS_BACKLOG`      | const | `10_485_760`            | Default soft high-water mark, in bytes, for the unconsumed backlog. |
| `PROCESS_OUTPUT`       | const | `10_485_760`            | Default maximum captured bytes for a run's stdout and stderr, each. |
| `PROCESS_TIMER`        | const | `2_147_483_647`         | The largest delay in milliseconds the host schedules as written.    |
| `PROCESS_PATHEXT`      | const | `'.COM;.EXE;.BAT;.CMD'` | The extensions a Windows lookup applies when `PATHEXT` is unset.    |
| `PROCESS_ERROR_CODES`  | const | the code tuple          | The declared `ProcessErrorCode` categories, in declaration order.   |

### Types

The contracts and options, all from `@orkestrel/process`.

| API                       | Kind      | Summary                                                                                                                          |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ProcessCommand`          | interface | One spawnable command — `file`, `arguments`, and optional `environment`, `input`, `isolated`.                                    |
| `ProcessExit`             | interface | The terminal state — an exit `code`, or the `signal` that ended the child.                                                       |
| `SpawnInput`              | interface | The resolved spawn form — the `file`, the `arguments`, and the `verbatim` flag.                                                  |
| `ExecutableOptions`       | interface | Lookup inputs for resolving a command file — `workspace` and `environment`.                                                      |
| `ProcessEventMap`         | type      | A `Process`'s events — `stderr(chunk)`, `error(cause)`, and `exit(exit)`.                                                        |
| `ProcessOptions`          | interface | `Process` construction — `command`, `workspace`, and the optional settings.                                                      |
| `ProcessInterface`        | interface | The supervised-child surface — `pid` / `code` / `signal` / `emitter` / `lines` / `evidence` / `truncated` / `exit` plus methods. |
| `ExecuteResult`           | interface | A one-shot outcome — the captured output, the exit, and the state flags.                                                         |
| `ExecuteInput`            | interface | The captured bytes and terminal facts one settled `ExecuteResult` is built from.                                                 |
| `ExecuteOptions`          | interface | `execute` options — workspace, environment, input, timeout, grace, signal, strict, limit.                                        |
| `ExecuteSyncOptions`      | interface | `executeSync` options — the same set without `grace` and without `signal`.                                                       |
| `DetachOptions`           | interface | `detach` options — the working directory the detached child starts in.                                                           |
| `ProcessManagerEventMap`  | type      | A manager's events — `launch(id)` and `exit(id, exit)`.                                                                          |
| `ProcessManagerOptions`   | interface | `ProcessManager` construction — initial `on` listeners and an `error` handler.                                                   |
| `ProcessManagerInterface` | interface | The registry surface — `emitter` / `count` plus the query, launch, stop, and destroy methods.                                    |
| `ProcessErrorCode`        | type      | The failure categories — `spawn`, `timeout`, `duplicate`, `protocol`, or `invalid`.                                              |
| `ProcessErrorContext`     | interface | Structured failure detail — `id`, `command`, `code`, `signal`, or `value`.                                                       |
| `ProcessErrorOptions`     | interface | `ProcessError` construction — `code` plus optional `context`, `cause`, `result`.                                                 |

### Server contracts

The Node-side contracts, from `@orkestrel/process/server`. They support the Node child boundary and
capture helper, so they stay out of the host-independent face.

| API                  | Kind      | Summary                                                                                                    |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `ProcessChild`       | interface | The child boundary the termination helpers drive — `pid`, `exitCode`, `signalCode`, `kill`, `once`, `off`. |
| `RetentionInterface` | interface | The retention surface — readonly `delivered` and `retained` totals plus `retain(chunk, limit)`.            |

### Surface notes

The `pid`, `code`, `signal`, `emitter`, `lines`, `evidence`, `truncated`, and `exit` members of
`ProcessInterface`, and the `emitter` and `count` members of `ProcessManagerInterface`, are readonly
data properties, so they stay Surface rows. Their call-signature methods are documented under
[Methods](#methods).

## Methods

The public methods of each behavioral interface. `Process` implements `ProcessInterface` exactly, and
`ProcessManager` implements `ProcessManagerInterface` exactly, so each table doubles as the class's
instance-method surface.

#### `RetentionInterface`

`Retention` implements `RetentionInterface` exactly. The `retain` method records each delivered buffer
and returns the retained head slice while room remains under the limit.

| Method   | Returns               | Behavior                                                                 |
| -------- | --------------------- | ------------------------------------------------------------------------ |
| `retain` | `Buffer \| undefined` | Record a delivered buffer and return its retained slice, or `undefined`. |

```ts
import { Buffer } from 'node:buffer'
import { Retention } from '@orkestrel/process/server'

const retention = new Retention()
retention.retain(Buffer.from('hello'), 3)?.toString('utf8') // 'hel'
retention.delivered // 5
retention.retained // 3
```

#### `ProcessInterface`

`send` writes one line to the child's stdin; `stop` and `destroy` are the lifecycle verbs. None of
them rejects. `stop` shares one termination across every call, and `destroy` returns one stable
barrier shared by every call.

| Method    | Returns            | Behavior                                                                                     |
| --------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `send`    | `Promise<boolean>` | Write one line to the open stdin channel; true when the line reached the host without error. |
| `stop`    | `Promise<boolean>` | Terminate the child tree and await its exit; true when the native exit was observed.         |
| `destroy` | `Promise<void>`    | Stop the child, destroy stdin, then destroy the emitter last; the barrier every call shares. |

#### `ProcessManagerInterface`

`process` and `processes` query the live registry; `launch` spawns and registers; `stop` is an
overloaded terminator; `destroy` tears the registry down. `stop` returns a `boolean` when you
name ids and `void` when you stop every child.

| Method      | Returns                         | Behavior                                                                                 |
| ----------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `process`   | `ProcessInterface \| undefined` | Return the live child under `id`, or `undefined` when none is.                           |
| `processes` | `readonly ProcessInterface[]`   | Return a snapshot of every live child, in launch order.                                  |
| `launch`    | `ProcessInterface`              | Spawn and register one child under `id`; throw a `ProcessError` on a refused launch.     |
| `stop`      | `Promise<boolean>`              | Terminate one named id, or every id in an array, and await their exit.                   |
| `stop`      | `Promise<void>`                 | With no argument, terminate every live child and await their exit.                       |
| `destroy`   | `Promise<void>`                 | Stop every child, then destroy the registry emitter last; the barrier every call shares. |

## Supervised children

`Process` spawns one child and captures both its streams. Standard output is framed through
`readline`, including a final line written without a trailing newline. Standard error is decoded and
forwarded live as the `stderr` event, while a byte-bounded raw tail is retained as `evidence` — the
diagnostic to attach to a failed exit. The typed `emitter` also carries the child `error` cause on a
spawn fault and the terminal `exit`, alongside the `exit` promise.

`ProcessOptions` requires `command` and `workspace`; the rest are optional:

| Option      | Type                            | Required | Meaning                                                                                                    |
| ----------- | ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `command`   | `ProcessCommand`                | yes      | The executable, its argument vector, and optional environment overrides and stdin `input`.                 |
| `workspace` | `string`                        | yes      | The working directory the child runs in.                                                                   |
| `grace`     | `number`                        | no       | POSIX milliseconds between `SIGTERM` and `SIGKILL`. Default: `PROCESS_GRACE` (`5_000`).                    |
| `evidence`  | `number`                        | no       | Maximum retained stderr tail in bytes. Default: `PROCESS_EVIDENCE` (`2_048`).                              |
| `backlog`   | `number`                        | no       | Soft high-water mark in bytes; termination retains at most twice `backlog`. Default: `PROCESS_BACKLOG`.    |
| `writable`  | `boolean`                       | no       | When `true`, stdin stays open for `send`; when `false` or omitted, stdin closes after any initial `input`. |
| `signal`    | `AbortSignal`                   | no       | Aborting this signal terminates the child through the same bounded `stop`.                                 |
| `on`        | `EmitterHooks<ProcessEventMap>` | no       | Initial `stderr`, `error`, and `exit` listeners installed at construction.                                 |
| `error`     | `EmitterErrorHandler`           | no       | Receives a listener's throw, isolated from the engine.                                                     |

There is no completion deadline. A caller that wants one arms its own timer and calls `stop`.

Every numeric option is validated at construction. A timer value outside `[0, PROCESS_TIMER]`, a
negative or fractional byte value, and a `backlog` below `1` each throw a `ProcessError` coded
`invalid` before anything is spawned, and so does a spawn-bound command string that is empty when
required or carries a NUL character. `input` is standard-input payload and carries no NUL
restriction.

Every option and command property is read once, before the child is spawned. Reading a property runs
whatever getter you put behind it, so hoisting those reads is what keeps a construction failure from
leaving a live child nobody holds: a getter that throws does so while nothing has started.

### The line backlog

`lines` is a single-consumer stream. Each line goes to exactly one waiting iterator, so concurrent
iterators over the same child split the output between them rather than each receiving all of it.
Iterate it once, and fan out from that loop when several readers need the same lines.

The `lines` policy follows consumer intent, and `backlog` bounds the unconsumed backlog in bytes.

- After an iterator has been requested, stdout pauses at the `backlog` mark and resumes at half of
  it. That consumer loses nothing before termination, and the child feels real backpressure.
- While no iterator has ever been requested, stdout keeps draining so `exit` still resolves, and
  retention stops at the mark. A consumer attaching after that point receives the retained head, then
  a gap, then the live stream.

The mark is soft in the pausing direction. `readline` frames every line a delivered chunk carries
before a pause takes effect, so the ordinary backlog can pass the mark by the line that crossed it
plus the rest of that chunk. Termination releases the pause and never reapplies it, because a paused
stdout holds the child's own write and therefore its exit. The teardown drain retains at most twice
`backlog`; it drops later lines without pausing stdout. The `truncated` property becomes `true` when
either the no-consumer mark or the termination cap omits a line, so a consumer can detect the gap.

A retained line costs its payload bytes plus the newline that framed it, so a line carrying no
payload still costs one byte. That is what bounds a flood of empty lines, which would otherwise be
free and defeat the mark entirely.

### Standard input

`writable: true` keeps stdin open for `send`. `send` never rejects and never throws: it resolves
`true` when the host reported the line handled, and `false` when the channel was closed, destroyed,
or ended, or when the write failed.

A stdin delivery failure is swallowed on purpose. The engine attaches a stdin `error` listener that
ignores the fault, so a child that closed its end of the pipe never crashes the caller with an
unhandled stream error. The failure still reaches you: `send` resolves `false`, the child's outcome
arrives through `exit`, and a caller that wants a deadline arms its own timer and calls `stop`. A
line written to a child that is not reading stays pending until the child drains it or the channel
closes, and every terminal teardown path destroys stdin, so a pending `send` always settles by
teardown.

```ts
import { createProcess } from '@orkestrel/process/server'

const echo = createProcess({
	command: {
		file: 'node',
		arguments: ['-e', 'process.stdin.on("data", (chunk) => process.stdout.write(chunk))'],
	},
	workspace: process.cwd(),
	writable: true,
})

await echo.send('ping') // true — the line reached the host
await echo.stop() // true — the native exit was observed
await echo.destroy()
```

### Termination

`stop` terminates the child tree, awaits its observed exit, and reports whether that exit arrived. It
resolves `true` when the child's native exit was observed and `false` when the confirmation wait
elapsed without it. Every call shares one termination, and the liveness fields are read again before
each signal, so no signal is initiated after an observed exit. The window between initiating a
signal and the host delivering it belongs to the operating system, which is the limit of what any
caller can hold. `destroy` runs `stop`, destroys stdin so every pending `send` settles, then destroys
the emitter last; it always resolves, including when termination was never confirmed.

`destroy` resolving does not mean the child's streams have closed. A descendant that inherited the
child's stdio holds the pipe open after the child itself is gone, so the close event never arrives
and the `exit` promise and the `lines` stream can both stay outstanding past the barrier. A caller
that must not wait on either arms its own timer around them.

POSIX detachment creates the process group that tree termination signals. The child therefore
survives the supervisor's `SIGKILL` and does not receive the terminal's `SIGINT`. Call `stop` or
`destroy` during an orderly shutdown.

Neither bounded wait leaks a listener. `destroy` removes the abort listener it registered on the
caller's `signal`, so a long-lived controller does not accumulate one per child. `waitForExit`
releases its own `exit` listener when its deadline elapses before the exit, so a child driven through
several bounded waits accumulates none either. `ProcessChild` declares the `off` that release needs,
so a caller composing a stop of its own from the published contract releases it too.

`PROCESS_CONFIRMATION` bounds each awaited step of a stop rather than the stop as a whole, so a
worst-case termination spends more than one of them. On a POSIX host the cooperative wait after
`SIGTERM` is bounded by `grace` and the wait after `SIGKILL` by `PROCESS_CONFIRMATION`. On Windows
the `taskkill` call is bounded by `PROCESS_CONFIRMATION` and the wait that follows it by another.

`executeSync` ends only the root process when its `timeout` elapses. A descendant can remain live
because the synchronous host exposes no tree-termination phase. Use `execute` or `Process` when the
timeout must terminate the child tree.

POSIX and Windows terminate differently, and only POSIX has a cooperative phase.

| Host    | Sequence                                                                                                                                        | `grace`  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| POSIX   | `SIGTERM` to the process group, wait `grace`, then `SIGKILL` to the group — each signal reaching the child directly when no group owns its pid. | used     |
| Windows | `taskkill /F /T` on the whole tree at once, with a direct kill after the utility reports failure.                                               | not used |

Windows has no signal a process group can receive, so `killTree` ends the tree through the
`taskkill.exe` utility addressed by its absolute `System32` path, which stops a `PATH` override
substituting another program. That call is bounded by the confirmation window and is killed itself
when the window elapses. A tree is discoverable only while its root lives, so a descendant that
outlives the root is beyond this mechanism; Windows job objects, which would close that gap, are not
part of this package.

`killProcess` is the direct signalling helper underneath. On a POSIX host it signals the negated pid,
which reaches the detached child's whole process group. When the host reports that no group owns the
pid, it falls back to signalling the child directly, so `killProcess` and `stopChild` also support a
non-detached child. On Windows, or when no pid is available, it signals the child alone. Every other
throw during signalling is swallowed, because the process can exit between the caller's liveness
check and the call, and the child's native exit stays the authoritative terminal state.

`pid` is the host id of the spawned child, and `code` and `signal` are the terminal pair the host
recorded for it. The spawn is eager, so `pid` carries a number by the time `createProcess` returns,
and a spawn that produced no child reports `undefined` for that child's whole lifetime. `code` and
`signal` are `null` while the child runs; the host records them at the native exit, which arrives
before the `exit` promise whenever a descendant holds the child's stdio open, so a supervisor inside
that window reads the terminal state from them. A spawn fault records the host's negative errno as
the `code`, the same value the `exit` promise carries.

An assigned id survives the exit, so `pid` reports no liveness on its own. Derive liveness as
`pid !== undefined && code === null && signal === null`, and derive it again before each use of the
id, because the host reuses a dead child's id and a signal sent to a reused id reaches the process
that holds it. Address a live child yourself with `process.kill(pid, 'SIGTERM')`; on a POSIX host,
negate the id to reach the detached child's whole process group, which is the route `killProcess`
takes.

```ts
import { createProcess } from '@orkestrel/process/server'

const controller = new AbortController()
const child = createProcess({
	command: { file: 'node', arguments: ['server.js'] },
	workspace: process.cwd(),
	grace: 2_000, // POSIX only: the window between SIGTERM and SIGKILL
	signal: controller.signal, // abort terminates through the same bounded stop
	on: {
		stderr: (chunk) => process.stderr.write(chunk),
		exit: ({ code }) => console.log(`server exited with code ${String(code)}`),
	},
})

controller.abort()
await child.exit
console.log(child.evidence) // the retained stderr tail, at most PROCESS_EVIDENCE bytes
await child.destroy()
```

## Command resolution

No spawn in this package uses an implicit shell. `buildSpawn` resolves one command into the file, the
argument vector, and a `verbatim` flag, and every entry point — `Process`, `execute`, `executeSync`,
and `detach` — spawns through it. The host boundary passes its platform into the pure candidate and
batch decisions. A metacharacter in an argument therefore reaches the child as data rather than as
syntax: the one path that builds a command line at all — a Windows `.cmd` or `.bat` script — runs
through an explicit quoted `cmd.exe /d /s /c` invocation, and the one argument that invocation could
corrupt is refused rather than passed.

A POSIX platform input leaves the file lookup to `execvp`, so `resolveExecutable` returns
`undefined` and the command file is spawned as written. A Windows platform input needs the lookup,
because the host searches the working directory before `PATH` and applies `PATHEXT`, and Node
reproduces neither for a direct spawn. `buildExecutableCandidates` makes that decision and the
ordered candidate list pure, so every platform input executes on every test host.
Within each searched directory the literal name is tried first and each `PATHEXT` candidate after
it, whether or not the name already carries an extension: `report.txt` resolves to a `report.txt`
file where one exists, and to `report.txt.cmd` where none does. The lookup reads the child's
effective environment, so an overridden `PATH` selects the executable the child would have found, it
falls back to `PROCESS_PATHEXT` when the environment declares no `PATHEXT`, and it accepts a
candidate only when `isFile` reports a regular file.

A resolved `.cmd` or `.bat` script cannot be spawned directly. `buildSpawn` runs it through an
explicitly quoted `cmd.exe /d /s /c` command line and sets `verbatim`, so the host receives that line
as written. `quoteArgument` wraps a token carrying whitespace or a metacharacter in double quotes and
doubles an embedded quote. `quoteArgument` includes `%` in the quoted set, so `quoteArgument('%1')`
returns `"%1"`. Quoting does not prevent percent expansion, which is why the batch path refuses that
argument before spawning.

One argument cannot survive that command line: `cmd.exe` expands `%NAME%` before it parses quotes,
so no quoting carries a percent sign through to a batch target. On Windows, `buildSpawn` refuses an
argument carrying `%` when the resolved target is `.cmd` or `.bat`, with a `ProcessError` coded
`invalid` carrying the argument on `context.value`. The batch path has two outcomes: an argument
reaches the child as written or the call fails. No path rewrites one. Off the batch path a percent
sign is ordinary text and passes untouched.

Because no spawn passes `shell: true`, Node's `DEP0190` deprecation warning — which fires when a
`.bat` or `.cmd` file is spawned through a shell with arguments — cannot come from this package.

The whole batch path is Windows-only, extension and all. A POSIX host has no `cmd.exe` and no
restriction on spawning a file directly, so a target named `worker.cmd` spawns directly there, keeps
`verbatim` at `false`, and receives a percent sign as literal text. The extension classifies a target
only on the host where the extension means something.

Every entry point snapshots the command before it validates, through `snapshotCommand`. The object
validated is the object spawned: each property is read exactly once, so a `file` getter that returns
one executable to the validator and another to the spawn cannot exist, and the argument vector and
the environment record are copied and frozen, so a caller mutating either after the call cannot reach
the child.

```ts
import {
	buildSpawn,
	formatCommand,
	quoteArgument,
	snapshotCommand,
} from '@orkestrel/process/server'

snapshotCommand({ file: 'git', arguments: ['status'] }) // { file: 'git', arguments: ['status'] }

formatCommand({ file: 'git', arguments: ['status'] }) // 'git status'
quoteArgument('status') // 'status'
quoteArgument('a&b') // '"a&b"'
quoteArgument('%1') // '"%1"'
buildSpawn({ file: 'node', arguments: ['--version'] }).verbatim // false
```

### The child environment

`mergeEnvironment` builds the environment one child receives. Later maps override earlier ones, an
`undefined` value unsets a key, and on Windows the keys fold case-insensitively with the last writer
winning, so `PATH` followed by `Path` yields one variable rather than two the host would resolve
unpredictably. `readVariable` reads one variable back under the same folding rule. Their
`mergePlatformEnvironment` and `readPlatformVariable` leaves accept an explicit platform, so every
folding decision executes on every test host.

`ProcessCommand.isolated` decides whether the parent environment is a layer at all. Omitted or
`false`, the overrides merge over the parent environment; `true`, the child environment is the
overrides alone from this package's side. That qualification is exact on Windows: libuv injects a
host set — `PATH`, `SYSTEMROOT`, `TEMP`, `USERPROFILE`, and several more — into any explicit
environment, so an isolated child there still receives those variables from the host.
On a POSIX host, `isolated: true` removes `PATH`, so pass an absolute file or include `PATH` in the
overrides when the child uses a bare command name.

```ts
import { mergeEnvironment } from '@orkestrel/process/server'

mergeEnvironment(true, { TOKEN: 'a' }) // { TOKEN: 'a' } — the overrides alone
mergeEnvironment(false, { TOKEN: 'a' }, { TOKEN: undefined }).TOKEN // undefined — the override unset it
```

Read the difference back from the child rather than from the merge, because the host has the last
word on it:

```ts
import { executeSync } from '@orkestrel/process/server'

const printer = 'process.stdout.write(Object.keys(process.env).sort().join(","))'
const keys = executeSync({
	file: process.execPath,
	arguments: ['-e', printer],
	environment: { TOKEN: 'a' },
	isolated: true,
}).stdout.split(',')

keys.includes('TOKEN') // true — the override reached the child
keys.includes('SYSTEMROOT') // true on Windows, false on a POSIX host
```

## One-shot runs

The `execute` function runs a command to completion, buffers its output, and resolves an
`ExecuteResult`. The `executeSync` function is the blocking counterpart. Use either when you want
the exit and the captured output together, without managing a live stream.

`ExecuteOptions` are all optional:

| Option        | Type                                  | Default               | Meaning                                                                  |
| ------------- | ------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `workspace`   | `string`                              | current directory     | The working directory.                                                   |
| `environment` | `Record<string, string \| undefined>` | inherit the parent    | Overrides applied last; `undefined` unsets a key.                        |
| `input`       | `string`                              | the command's `input` | Standard-input payload, including NUL, overriding `command.input`.       |
| `timeout`     | `number`                              | `0` (disabled)        | Milliseconds before the child is terminated; `0` or omitted disables it. |
| `grace`       | `number`                              | `PROCESS_GRACE`       | The POSIX `SIGTERM` to `SIGKILL` window when a timeout or abort ends it. |
| `signal`      | `AbortSignal`                         | none                  | Aborting this signal terminates the run and reports `aborted`.           |
| `strict`      | `boolean`                             | `true`                | When `false`, resolve with the result on failure instead of rejecting.   |
| `limit`       | `number`                              | `PROCESS_OUTPUT`      | Maximum captured bytes for stdout and for stderr, each.                  |

`ExecuteSyncOptions` carries the same set without `grace` and without `signal`, because the
synchronous host offers neither a cooperative termination window nor in-flight cancellation.

Every option and command property is read once, before the child is spawned, in `execute` and in
`executeSync` alike. The value validated is therefore the value spawned, whatever a getter behind an
option returns on a later read, and a getter that throws does so while nothing has started.

`input` is standard-input payload and carries no NUL restriction on either option shape:

```ts
import { executeSync } from '@orkestrel/process/server'

const input = `left${String.fromCodePoint(0)}right`
const echoed = executeSync(
	{ file: process.execPath, arguments: ['-e', 'process.stdin.pipe(process.stdout)'] },
	{ input },
)
echoed.stdout === input // true
```

A run with no `timeout` and no `signal` is unbounded, and what it waits for is stdio completion
rather than process exit. A descendant that inherits the child's stdio holds those pipes open after
the child itself has exited, and the run stays pending for as long as the descendant lives. Give
`execute` a `timeout` wherever the command may start a descendant that inherits its stdio; the bound
that the later [Where `execute` and `executeSync` differ](#where-execute-and-executesync-differ)
section describes applies to a terminated run and cannot rescue one that was never bounded.

### The result family

`ExecuteResult` reports the outcome through booleans. `failed` is derived from the rest of the
result, and `expired`, `aborted`, and `truncated` each report one specific thing that happened.

| Field       | True when                                                                  |
| ----------- | -------------------------------------------------------------------------- |
| `failed`    | The run did not complete successfully, whatever ended it.                  |
| `expired`   | The run's own `timeout` elapsed before completion.                         |
| `aborted`   | The caller's `signal` aborted the run before completion.                   |
| `truncated` | Either stream exceeded `limit`, so the captured text is the retained head. |

`failed` is derived: a run failed when it expired, was aborted, ended on a host fault, was ended by a
signal, or exited with a code other than `0`. A `null` code from a spawn fault is therefore a
failure, an abort is a failure, and a synchronous overflow is a failure. `expired` and `aborted` are
the ways the run ended the child rather than the child ending itself, and only the earliest observed
is recorded, so they are never both `true`.

A spawn fault reports the host's negative errno in `ProcessExit.code` and an asynchronous
`ExecuteResult.code`. The synchronous `executeSync` result reports `null` instead.

By default a failed run rejects with a `ProcessError` carrying the `ExecuteResult` on its `result`
property. An expired run carries code `timeout`; every other failure carries code `spawn`. Passing
`strict: false` settles with the result even on failure, so you inspect `failed` yourself.

```ts
import { execute } from '@orkestrel/process/server'

// Rejecting form (the default): a failed run throws.
const version = await execute({ file: 'node', arguments: ['--version'] })
version.failed // false
version.stdout.startsWith('v') // true

// Non-rejecting form: inspect the outcome directly.
const outcome = await execute(
	{ file: 'node', arguments: ['-e', 'process.exit(3)'] },
	{ strict: false },
)
outcome.failed // true
outcome.code // 3
```

### Output bounds

Each of `stdout` and `stderr` is capped at `limit` bytes, keeping the captured head and never
splitting a UTF-8 sequence. `truncated` reports that a cap was reached; `execute` and `executeSync`
differ in what they do about it.

One `truncated` flag covers both streams, so a consumer that parses `stdout` structurally cannot
tell from the result which stream overflowed. Nothing in the result recovers that: both captured
strings are trimmed to `limit`, so a stream that stopped exactly at the cap and a stream that ran
past it read the same length. Where the distinction matters, re-run with a `limit` high enough that
`truncated` is `false`, then compare each captured length against the original bound — or supervise
the child with `Process`, which bounds `lines` and `evidence` separately.

`execute` keeps reading past the cap, discards the excess, and reports `truncated` without failing
the run. `executeSync` hands `limit` to the host as its buffer ceiling, so an overflow ends the
child with `SIGKILL` and reports `truncated` and `failed` together, with the partial output trimmed
to `limit`.

```ts
import { execute, executeSync } from '@orkestrel/process/server'

const script = 'process.stdout.write("x".repeat(4096))'

const streamed = await execute(
	{ file: 'node', arguments: ['-e', script] },
	{ limit: 16, strict: false },
)
streamed.truncated // true
streamed.failed // false

const blocking = executeSync(
	{ file: 'node', arguments: ['-e', script] },
	{ limit: 16, strict: false },
)
blocking.truncated // true
blocking.failed // true
blocking.signal // 'SIGKILL'
```

### Where `execute` and `executeSync` differ

`executeSync` is not a synchronous mirror of `execute`. Read the differences before you swap one
for the other.

| Subject         | `execute`                                                 | `executeSync`                                        |
| --------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| Cooperative end | `grace` between `SIGTERM` and `SIGKILL` on a POSIX host.  | None; a timeout ends the root alone with `SIGKILL`.  |
| Descendants     | A timeout or abort terminates the child tree.             | A timeout can leave descendants running.             |
| Cancellation    | An `AbortSignal` terminates the run and sets `aborted`.   | None; the host offers no in-flight cancellation.     |
| Overflow        | Reports `truncated` and keeps the run successful.         | Reports `truncated` and `failed`, killing the child. |
| Spawn fault     | Reports the host's negative errno in `code`.              | Reports `null` in `code`.                            |
| Refusal         | Rejects before spawning, because it is an async function. | Throws before spawning.                              |

Both share the rest: the same resolver and no implicit shell, the same environment merge, the same
`input` override, the same `limit` bounding, and the same `strict` behavior.

`execute` also bounds what follows termination. After a timeout or an abort ends the child,
`stopChild` runs and the outcome is then awaited for one further `PROCESS_CONFIRMATION`, so a
descendant still holding the child's stdio cannot keep a terminated run pending forever. Nothing
bounds a run that was never terminated: with no `timeout` and no `signal` there is no deadline to
reach, and the run waits on stdio completion for as long as the descendant holds the pipe.

## Detached spawns

`detach` spawns a command and returns immediately. The child owns no stdio, is unreferenced, and
outlives this process, so nothing here observes its outcome. Its environment comes from the command's
own `environment` and `isolated` rather than from a per-invocation override, and `DetachOptions`
carries only the directory the child starts in.

`detach` returns nothing, not a process id. Fire-and-forget is the whole contract: an id you cannot
observe an exit for invites a supervision you would have to build yourself. Use `Process` when you
need the pid, the streams, the events, or a bounded stop.

`detach` validates first, so a malformed working directory or command string throws a `ProcessError`
coded `invalid` before anything is spawned. It reads each option once, so the working directory it
validated is the one the child starts in. After the spawn, a host fault is swallowed rather than
crashing the caller.

```ts
import { detach } from '@orkestrel/process/server'

detach({ file: process.execPath, arguments: ['-e', ''] }, { workspace: process.cwd() })
```

## The keyed registry

`ProcessManager` holds live children by id. `launch` spawns a `Process` under an id, registers it,
and emits `launch`. A child that settles removes itself from the registry and emits `exit`, so
`count` and `processes` reflect only live children, and that eviction needs no polling. `destroy`
destroys every child, clears the registry, then destroys the registry emitter last, so `count` is `0`
afterwards.

`destroy` tears each child down rather than only stopping it, so each child's own observation emitter
is destroyed too and every subscription on it goes silently inert: a `stderr` or `exit` listener
registered on a child stops firing, and nothing reports that it did. The registry emitter is
destroyed after all of them. Read a terminal state you still need from the child's `exit` promise,
which settles independently of any emitter.

Eviction follows the child's own `exit` promise, which no listener can forge, so it lands one
microtask after the child's public `exit` event. A listener on that event still sees the child
registered; a listener on the manager's `exit` event sees it gone.

```ts
import { createProcessManager } from '@orkestrel/process/server'

const manager = createProcessManager({
	on: {
		launch: (id) => console.log(`launched ${id}`),
		exit: (id, { code }) => console.log(`${id} exited with code ${String(code)}`),
	},
})

const child = manager.launch('probe', {
	command: { file: 'node', arguments: ['--version'] },
	workspace: process.cwd(),
})
manager.count // 1
manager.process('probe') === child // true
manager.processes().length // 1

await child.exit
manager.count // 0 — the settled child evicted itself

await manager.destroy()
```

`launch` refuses in these ways, and a spawn fault is none of them: a child that fails to spawn is
returned, and its fault surfaces through its own `exit` and `error` event rather than from `launch`.

- A `duplicate`-coded `ProcessError` when the id is already live.
- A `protocol`-coded `ProcessError` after `destroy` has begun. The check runs again after the child
  exists, because reading an option runs your own code and that code can start the teardown; a
  registry being destroyed adopts nothing, so the child it has already spawned is destroyed and the
  launch is still refused. The `protocol` refusal throws synchronously before the `destroy` barrier
  settles. The barrier does not cover the child's asynchronous teardown.
- An `invalid`-coded `ProcessError` when an option or command string is malformed. The id is
  reserved before the child is constructed and released when construction throws, so a refused launch
  strands no key.

The `stop` overloads terminate by scope. `stop(id)` resolves `true` only when the child was live and
its native exit was confirmed, so a not-live id and an unconfirmed termination both resolve `false`.
`stop(ids)` resolves `true` only when every named child did. `stop()` with no argument terminates
every live child and resolves `void`.

## Errors

`ProcessError` is the one failure type, carrying a stable machine-readable `code`. Narrow a caught
value with `isProcessError`, then branch on `code`.

| Code        | Raised when                                                     |
| ----------- | --------------------------------------------------------------- |
| `spawn`     | A rejecting run failed for a reason other than its own timeout. |
| `timeout`   | A rejecting run's own `timeout` elapsed before completion.      |
| `duplicate` | `ProcessManager.launch` reused an id that is already live.      |
| `protocol`  | `ProcessManager.launch` ran after `destroy` had begun.          |
| `invalid`   | A public input was refused before anything was spawned.         |

`isProcessError` recognizes an error thrown by another installed copy of the package. It reads a
global own-property brand rather than `instanceof`, so a duplicate installation and an ESM/CommonJS
module copy both narrow, where a prototype check would refuse both. Recognition holds across copies
at 0.0.4 or later: a copy earlier than 0.0.4 stamps no brand, so an error it throws stays outside the
type. The guard admits exactly the codes `PROCESS_ERROR_CODES` declares, so a code added there is
admitted with no further edit.

A run failure carries its `ExecuteResult` on `error.result`, and its command line, exit `code`, and
`signal` on `error.context`. A duplicate-id and a protocol failure carry the offending `id` on
`error.context`. A validation failure carries the rejected input on `error.context.value`. The
underlying cause, when one exists, is retained on `error.cause`.

```ts
import { createDuplicateError, createInvalidError, createProtocolError } from '@orkestrel/process'

createDuplicateError('build').code // 'duplicate'
createProtocolError('build').code // 'protocol'
createInvalidError("option 'grace'", -1).code // 'invalid'
createInvalidError("option 'grace'", -1).context?.value // -1
```

Every public entry point validates before it spawns. `execute` rejects rather than throwing, because
an async function cannot throw synchronously; the `Process` constructor, `executeSync`, and `detach`
all throw.

```ts
import { executeSync } from '@orkestrel/process/server'
import { isProcessError } from '@orkestrel/process'

try {
	executeSync({ file: 'node', arguments: ['--version'] }, { timeout: -1 })
} catch (error) {
	if (isProcessError(error)) {
		error.code // 'invalid'
		error.context?.value // -1
	}
}
```

`createExecuteError` is the factory behind a rejecting run, and `buildExecuteResult` assembles the
result it carries.

```ts
import { buildExecuteResult } from '@orkestrel/process/server'
import { createExecuteError } from '@orkestrel/process'

const result = buildExecuteResult({
	command: 'node -e process.exit(1)',
	stdout: new TextEncoder().encode('ok'),
	stderr: new Uint8Array(0),
	code: 1,
	signal: null,
	expired: false,
	aborted: false,
	truncated: false,
	limit: 1_024,
})

result.failed // true
createExecuteError(result).code // 'spawn'
createExecuteError(result).result === result // true
```

## Observing

Both `Process` and `ProcessManager` expose a typed `emitter` for fire-and-forget observers —
logging, metrics, tracing. Subscribe through `child.emitter.on(...)` or `manager.emitter.on(...)`, or
wire initial listeners through the `on` option; supply an `error` handler to receive a listener's
throw. The `error` handler and the `Process` `error` event are distinct: the handler receives a
listener's own throw, while the `error` event carries a child fault. Emitting is observation-only:
every event fires after the transition it reports, and a throwing listener is isolated and routed to
the `error` handler, never onto a domain event, so a faulty observer cannot corrupt the engine.

| Event map                | Events                                          |
| ------------------------ | ----------------------------------------------- |
| `ProcessEventMap`        | `stderr(chunk)` · `error(cause)` · `exit(exit)` |
| `ProcessManagerEventMap` | `launch(id)` · `exit(id, exit)`                 |

A `Process` emits `stderr` for each decoded standard-error chunk, `error` with its cause when the
child fails to spawn or errors, and `exit` once, with the terminal `ProcessExit`, when the child
settles. A spawn fault emits `error` and then still resolves `exit`. A `ProcessManager` emits
`launch` when a child joins the registry and `exit`, with the child's id and terminal state, when it
settles and leaves.

```ts
import { createProcess } from '@orkestrel/process/server'

const child = createProcess({
	command: { file: 'node', arguments: ['worker.js'] },
	workspace: process.cwd(),
})

child.emitter.on('stderr', (chunk) => log.warn(chunk))
child.emitter.on('exit', ({ code, signal }) => metrics.record('worker.exit', { code, signal }))
```

## Patterns

### Collect output in one call

```ts
import { execute } from '@orkestrel/process/server'

const { stdout } = await execute({ file: 'git', arguments: ['rev-parse', 'HEAD'] })
const commit = stdout.trim()
```

### Stream a long-running child and cancel it

```ts
import { createProcess } from '@orkestrel/process/server'

const controller = new AbortController()
const child = createProcess({
	command: { file: 'node', arguments: ['tail.js'] },
	workspace: process.cwd(),
	grace: 1_000,
	signal: controller.signal,
})

setTimeout(() => controller.abort(), 10_000) // stop after ten seconds
for await (const line of child.lines) console.log(line)
await child.exit
await child.destroy()
```

### Supervise a fleet by id

```ts
import { createProcessManager } from '@orkestrel/process/server'

const manager = createProcessManager()
for (const task of ['lint', 'test', 'build']) {
	manager.launch(task, {
		command: { file: 'npm', arguments: ['run', task] },
		workspace: process.cwd(),
	})
}
// …on shutdown, stop everything and tear down:
await manager.destroy()
```

### Build a bounded stop of your own

The termination helpers are the pieces `stop` composes, and they are exported so a caller supervising
a child it spawned itself gets the same bounded sequence. Reach for `stopChild` first: it is the
whole sequence, host-aware, and it never signals a process it has already seen exit.

```ts
import { spawn } from 'node:child_process'
import { stopChild } from '@orkestrel/process/server'

const worker = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 50)'], {
	detached: process.platform !== 'win32',
	stdio: 'ignore',
})

const confirmed = await stopChild(worker, 5_000, 5_000)
confirmed // true when the native exit arrived
```

Drive the pieces yourself only when you want a different sequence — a shorter cooperative window, an
extra warning signal, a step of your own between them. Guard each step with `isExited`, and drive a
child `stopChild` has not been called on: after the host reuses a dead child's process id, signalling
that id reaches its new process.

```ts
import { spawn } from 'node:child_process'
import { isExited, killProcess, killTree, waitForExit } from '@orkestrel/process/server'

const reporter = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 50)'], {
	detached: process.platform !== 'win32',
	stdio: 'ignore',
})

if (!isExited(reporter)) {
	killProcess(reporter, 'SIGTERM') // POSIX: the whole process group
	await waitForExit(reporter, 1_000)
}
if (!isExited(reporter) && process.platform === 'win32') {
	await killTree(reporter.pid ?? 0, 5_000)
}
if (!isExited(reporter)) {
	killProcess(reporter, 'SIGKILL')
	await waitForExit(reporter, 5_000)
}
isExited(reporter) // whether the native exit arrived
```

### Practices

- **Set `grace` to the child's real cleanup budget on a POSIX host** — `stop` waits that long after
  `SIGTERM` before `SIGKILL`, so a child that flushes on shutdown needs enough of a window to finish.
  Windows has no cooperative phase, so the value does nothing there.
- **Read `truncated` rather than assuming captured output is complete** — a `Process` reports a
  `lines` omission, and a run reports the `limit` it hit; a synchronous run fails on that limit while
  an asynchronous run does not.
- **Raise `backlog` for a chatty child you iterate slowly** — the default holds `PROCESS_BACKLOG`
  bytes of unconsumed lines before stdout pauses. Pausing keeps that consumer lossless before
  termination; from the moment a stop begins, retention is capped at twice `backlog`, later lines are
  dropped without pausing, and `truncated` reports the gap.
- **Attach a consumer before the child speaks, or accept the gap** — a `lines` iterator requested
  after the mark was exceeded receives the retained head, a gap, then the live stream.
- **Iterate `lines` once and fan out from that loop** — the stream is single-consumer, so another
  iterator takes lines away from the one already iterating rather than repeating them.
- **Give `execute` a `timeout` when the command can start a descendant** — an unbounded run waits on
  stdio completion, and a descendant that inherited the child's pipes holds it open past the child's
  own exit.
- **Derive liveness before you address `pid`** — a live child is
  `pid !== undefined && code === null && signal === null`, and the host reuses a dead child's id, so
  a signal sent without that check reaches whatever process holds the id.
- **Read `evidence` on a failed exit** — the byte-bounded stderr tail is the diagnostic to attach,
  bounded by `evidence` (default `PROCESS_EVIDENCE`).
- **Observe, do not drive** — subscribe to `emitter` for lifecycle moments; emitting is a pure
  side-channel, so a listener never changes what the engine does.

## Vocabulary

Each name on this surface that reads against a house rule is settled here rather than rediscovered.

| Name                     | Ruling                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute`, `executeSync` | Use the fixed lifecycle verb for primary work to completion. `executeSync` keeps the ecosystem `Sync` suffix.                                                                                                                    |
| `process`, `processes`   | Retained. A registry exposes its contents as accessors named for what they hold, so the manager reads `manager.process(id)` and `manager.processes()`.                                                                           |
| `strict`                 | Replaces `reject`. A boolean reads as an adjective asserting a state, and `reject` named the reaction rather than the mode. `strict: false` resolves with the failed result.                                                     |
| `evidence`, `backlog`    | Byte bounds are named for their subject where an entity has several, so a `Process` carries `evidence` and `backlog` rather than flavours of `limit`. A run has one bound, so it is named for the bound: `limit`.                |
| `truncated`              | One name on both surfaces, because it reports one fact: the surface omitted output. Each entity names its own bound — a `Process` omits `lines` past a retention bound, and an `ExecuteResult` omits captured text past `limit`. |
| `run`                    | Kept as the English noun for one invocation — a terminated run, a run that stays pending. It never names a function; `execute` and `executeSync` are named by their identifiers, so the concept carries one term.                |

## Tests

The pure platform-decision rows execute both `win32` and POSIX inputs on every host. They cover
environment-key folding and merging, `PATHEXT` candidate order, batch routing, argument quoting, and
the percent-sign refusal. Those rows were last proven on Linux on 2026-08-20. The live POSIX rows
were also last proven on Linux on 2026-08-20.

The live Windows filesystem, `cmd.exe`, and `taskkill.exe` rows execute on Windows only. Their
pre-`b392629` form was last proven on Windows; the current fixtures have not run there. The exact
unproven residue is `killTree` through `taskkill.exe` and grandchild tree termination through a live
root. On a Windows host, settle it and re-run every server row with this command:

```text
npx vitest run --config vite.config.ts --no-cache --project src:server
```

The pure decision rows do not prove Windows end to end. They prove the decisions.

- [`tests/src/core/errors.test.ts`](../tests/src/core/errors.test.ts) — the error surface:
  `isProcessError` narrowing its own error and refusing a plain `Error`, the codes the guard admits
  compared against the declared `PROCESS_ERROR_CODES` tuple with a refusal control drawn from
  outside it, and recognition of an error constructed by another source copy of the module.
- [`tests/src/server/Process.test.ts`](../tests/src/server/Process.test.ts) — the supervised child:
  line framing including a trailing partial line, the bounded backlog under each consumer policy
  and under a flood of empty lines, the byte-bounded `evidence` tail and live `stderr` event, `send`
  over an open and a closed channel, bounded termination and its confirmation, the POSIX escalation
  from a trapped `SIGTERM` to `SIGKILL`, abort-signal termination, the isolated environment, the
  `invalid` refusals, and `destroy`.
- [`tests/src/server/Retention.test.ts`](../tests/src/server/Retention.test.ts) — the stream-head
  accumulator: delivered and retained totals across a truncating stream.
- [`tests/src/server/ProcessManager.test.ts`](../tests/src/server/ProcessManager.test.ts) — the
  registry: `launch` registration and its `duplicate`, `protocol`, and `invalid` refusals, including
  a teardown started from inside the caller's own option getter, the unforgeable eviction and its
  ordering, the query surface, the `stop` overloads, and emitter-last `destroy`.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) — the building blocks:
  the resolver under `PATHEXT` and an extension-bearing name, each platform input to the quoted
  batch builder and its percent-sign refusal, the environment merge under each platform input, the
  UTF-8-safe byte bounds, the validators, and the termination helpers.
- [`tests/src/server/execution/execute.test.ts`](../tests/src/server/execution/execute.test.ts) —
  the asynchronous one-shot run: owned inputs, buffered outcomes, failure delivery, cancellation,
  timeout, capture bounds, spawn faults, and pre-spawn refusal.
- [`tests/src/server/execution/executeSync.test.ts`](../tests/src/server/execution/executeSync.test.ts)
  — the blocking one-shot run: owned inputs, root-only timeout, buffered outcomes, failure delivery,
  capture bounds, argument integrity, spawn faults, and pre-spawn refusal.
- [`tests/src/server/execution/detach.test.ts`](../tests/src/server/execution/detach.test.ts) — the
  fire-and-forget spawn: owned inputs, detached process-group behavior, invalid-input refusal, and
  the validated working directory.
- [`tests/guides.test.ts`](../tests/guides.test.ts) — this guide: every documented name resolves,
  every public export is documented, and every flagship fence returns what its comments claim.
- [`tests/distribution.test.ts`](../tests/distribution.test.ts) — the artifact a consumer installs:
  it packs the package, installs the tarball into a directory outside this repository, and compares
  the runtime exports of each built format against the declarations the compiler parses, under each
  supported `moduleResolution` mode.
- [`tests/setup.test.ts`](../tests/setup.test.ts) — `waitForCondition`, the polled wait this suite
  uses in place of a fixed delay: when it returns, when it rejects, and the budget it names.

## See also

- [`@orkestrel/emitter`](https://github.com/orkestrel/emitter#readme) — the typed push-observation
  primitive each `emitter` is built on.
- [`@orkestrel/contract`](https://github.com/orkestrel/contract#readme) — the guard primitive
  `isProcessError` composes.
- [`AGENTS.md`](../AGENTS.md) — the repository coding, naming, and lifecycle rules.
- [`README.md`](README.md) — the guides index.
