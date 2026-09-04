# Process

> A typed child-process toolkit in tiers. `Process` supervises one child with framed stdout
> lines under a bounded backlog, a byte-bounded stderr tail, a live `stderr` event, a writable stdin
> channel, a typed lifecycle emitter, and a bounded termination that ends every observation channel
> at one terminal moment. `Session` supervises the same child as raw bytes instead: one owned
> `Uint8Array` per stdout chunk, an `end` that closes stdin without terminating anything, and the
> child's own `ending` beside the terminal `exit`. `execute` and `executeSync` buffer a
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
channel, or the lifecycle events. Reach for `Session` when the child speaks a protocol and you need
its exact bytes rather than framed lines. Reach for `execute` or `executeSync` when you want the
buffered output and the exit in one call. Reach for `ProcessManager` when you supervise several
children by id.

### Factories

The interface-oriented constructors, from `@orkestrel/process/server`.

| API                    | Kind     | Summary                                                       |
| ---------------------- | -------- | ------------------------------------------------------------- |
| `createProcess`        | function | Spawn one supervised child and return its `ProcessInterface`. |
| `createSession`        | function | Spawn one supervised child and return its `SessionInterface`. |
| `createProcessManager` | function | Construct an empty `ProcessManagerInterface` registry.        |

### Spawns

The one-shot and fire-and-forget spawns, from `@orkestrel/process/server`.

| API           | Kind     | Summary                                                                         |
| ------------- | -------- | ------------------------------------------------------------------------------- |
| `execute`     | function | Run a command to completion, buffer its output, and resolve an `ExecuteResult`. |
| `executeSync` | function | The blocking counterpart of `execute`, returning the `ExecuteResult` directly.  |
| `detach`      | function | Spawn a command detached with no stdio and return without waiting for it.       |

### Entities

The classes a factory constructs and the `Supervisor` engine a consumer constructs directly, from
`@orkestrel/process/server`, and the error type from `@orkestrel/process`.

| API              | Kind  | Summary                                                                                                                                    |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Process`        | class | The supervised child engine — framed lines under a bounded backlog.                                                                        |
| `Session`        | class | The same supervised child read as raw bytes over an open stdin channel.                                                                    |
| `Supervisor`     | class | The spawn, capture, channel, and termination engine a face composes; its readonly members are named under [Surface notes](#surface-notes). |
| `ProcessManager` | class | The keyed registry of live children with auto-eviction on exit.                                                                            |
| `ProcessError`   | class | A child-process failure with a stable machine-readable `code`.                                                                             |

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

### Capture helpers

The byte-bounding and result-assembly building blocks, from `@orkestrel/process/server`.

| API                  | Kind     | Summary                                                                     |
| -------------------- | -------- | --------------------------------------------------------------------------- |
| `trimHead`           | function | Keep at most `limit` leading bytes without splitting a UTF-8 sequence.      |
| `trimTail`           | function | Keep at most `limit` trailing bytes without splitting a UTF-8 sequence.     |
| `captureChunk`       | function | Bound one delivered stream chunk to the bytes a capture still has room for. |
| `buildExecuteResult` | function | Assemble one frozen `ExecuteResult` from captured bytes and terminal facts. |

### Termination helpers

The signalling and confirmation building blocks a bounded stop composes, from
`@orkestrel/process/server`.

| API            | Kind     | Summary                                                                   |
| -------------- | -------- | ------------------------------------------------------------------------- |
| `isExited`     | function | Report whether a child has reached its native exit.                       |
| `killProcess`  | function | Signal one child, or its detached process group on a POSIX host.          |
| `killTree`     | function | End one Windows process tree through `taskkill`, bounded by a deadline.   |
| `waitForExit`  | function | Await one child's native exit, bounded by a deadline.                     |
| `waitForClose` | function | Await one child's stream close, bounded by a deadline.                    |
| `stopChild`    | function | Terminate one child tree and report whether its native exit was observed. |

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
| `PROCESS_DRAIN`        | const | `1_000`                 | Default milliseconds a termination waits for the streams to close.  |
| `PROCESS_EVIDENCE`     | const | `2_048`                 | Default maximum retained stderr tail, in bytes, for a `Process`.    |
| `PROCESS_BACKLOG`      | const | `10_485_760`            | Default soft high-water mark, in bytes, for the unconsumed backlog. |
| `PROCESS_OUTPUT`       | const | `10_485_760`            | Default maximum captured bytes for a run's stdout and stderr, each. |
| `PROCESS_TIMER`        | const | `2_147_483_647`         | The largest delay in milliseconds the host schedules as written.    |
| `PROCESS_PATHEXT`      | const | `'.COM;.EXE;.BAT;.CMD'` | The extensions a Windows lookup applies when `PATHEXT` is unset.    |
| `PROCESS_ERROR_CODES`  | const | the code tuple          | The declared `ProcessErrorCode` categories, in declaration order.   |

### Types

The contracts and options, all from `@orkestrel/process`.

| API                       | Kind      | Summary                                                                                                                                                   |
| ------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProcessCommand`          | interface | One spawnable command — `file`, `arguments`, and optional `environment`, `input`, `isolated`.                                                             |
| `ProcessExit`             | interface | The terminal state — an exit `code` or the `signal` that ended the child, plus the `drained` discriminant.                                                |
| `SpawnInput`              | interface | The resolved spawn form — the `file`, the `arguments`, and the `verbatim` flag.                                                                           |
| `ExecutableOptions`       | interface | Lookup inputs for resolving a command file — `workspace` and `environment`.                                                                               |
| `ProcessEventMap`         | type      | A `Process`'s events — `stderr(chunk)`, `error(cause)`, and `exit(exit)`.                                                                                 |
| `ProcessOptions`          | interface | `Process` construction — `command`, `workspace`, and the optional settings.                                                                               |
| `ProcessInterface`        | interface | The supervised-child surface — `pid` / `code` / `signal` / `emitter` / `lines` / `evidence` / `truncated` / `settled` / `stopping` / `exit` plus methods. |
| `SessionEventMap`         | type      | A `Session`'s events — `stdout(chunk)`, `stderr(chunk)`, `error(cause)`, and `exit(exit)`.                                                                |
| `SessionOptions`          | interface | `Session` construction — `ProcessOptions` without `backlog` and without `writable`.                                                                       |
| `SessionInterface`        | interface | The byte-session surface — `pid` / `code` / `signal` / `emitter` / `evidence` / `settled` / `stopping` / `ending` / `exit` plus methods.                  |
| `ExecuteResult`           | interface | A one-shot outcome — the captured output, the exit, and the state flags.                                                                                  |
| `ExecuteInput`            | interface | The captured bytes and terminal facts one settled `ExecuteResult` is built from.                                                                          |
| `ExecuteOptions`          | interface | `execute` options — workspace, environment, input, timeout, grace, signal, strict, limit.                                                                 |
| `ExecuteSyncOptions`      | interface | `executeSync` options — the same set without `grace` and without `signal`.                                                                                |
| `DetachOptions`           | interface | `detach` options — the working directory the detached child starts in.                                                                                    |
| `ProcessManagerEventMap`  | type      | A manager's events — `launch(id)` and `exit(id, exit)`.                                                                                                   |
| `ProcessManagerOptions`   | interface | `ProcessManager` construction — initial `on` listeners and an `error` handler.                                                                            |
| `ProcessManagerInterface` | interface | The registry surface — `emitter` / `count` plus the query, launch, stop, and destroy methods.                                                             |
| `ProcessErrorCode`        | type      | The failure categories — `spawn`, `timeout`, `input`, `duplicate`, `protocol`, or `invalid`.                                                              |
| `ProcessErrorContext`     | interface | Structured failure detail — `id`, `command`, `code`, `signal`, or `value`.                                                                                |
| `ProcessErrorOptions`     | interface | `ProcessError` construction — `code` plus optional `context`, `cause`, `result`.                                                                          |

### Server contracts

The Node-side contracts, from `@orkestrel/process/server`. Each sits in this face rather than
the host-independent one for its own reason: `ProcessChildInterface` names `NodeJS.Signals`, which
a host-independent contract cannot, and `SupervisorFace` names no Node type but its consumer is the
Node-only `Supervisor` engine, so the contract sits with the face that constructs one.

| API                     | Kind      | Summary                                                                                                                                                                            |
| ----------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProcessChildInterface` | interface | The child boundary the termination helpers drive — the readonly `pid`, `exitCode`, and `signalCode`.                                                                               |
| `SupervisorFace`        | interface | The callback record a face hands `Supervisor` at construction — `chunk`, `fault`, `relieve`, `close`, `terminal`, `teardown`; see [Vocabulary](#vocabulary) for the `Face` suffix. |

### Surface notes

The `pid`, `code`, `signal`, `emitter`, `lines`, `evidence`, `truncated`, `settled`, `stopping`, and
`exit` members of `ProcessInterface`, the `pid`, `code`, `signal`, `emitter`, `evidence`, `settled`,
`stopping`, `ending`, and `exit` members of `SessionInterface`, the `emitter` and `count` members
of `ProcessManagerInterface`, the `pid`, `exitCode`, and `signalCode` members of
`ProcessChildInterface`, and every member of `SupervisorFace`, are readonly data properties, so they
stay Surface rows. `ending` and `exit` are among them: a promise you await is a value the entity
holds, not a call you make. A `SupervisorFace` member is among them too: it holds a function the
caller supplies rather than declaring one the contract implements. Their call-signature methods are
documented under [Methods](#methods).

The `Supervisor` class publishes readonly data members of its own: `stdout`, `pid`, `code`, `signal`,
`evidence`, `settled`, `stopping`, `ending`, and `exit`. It declares no interface, so they are named
here rather than in a Surface row. `stdout` holds the child's standard-output stream, and it is the
stream a composing face attaches its own consumer to, because the engine frames no output and owns
no observation surface. `pid`, `code`, and `signal` read the host child directly and `ending` settles
with it, while `evidence`, `settled`, and `exit` reach
[the terminal moment](#the-terminal-moment) after the read channels close or the `drain` window cuts
them off.

## Methods

The public methods of each behavioral interface, and of the `Supervisor` class that publishes its
own. `Process` implements `ProcessInterface` exactly, `Session` implements `SessionInterface`
exactly, and `ProcessManager` implements `ProcessManagerInterface` exactly, so each table doubles as
the class's instance-method surface.

#### `ProcessInterface`

`send` writes one line to the child's stdin; `stop` and `destroy` are the lifecycle verbs. None of
them rejects. `stop` shares one termination across every call, and `destroy` returns one stable
barrier shared by every call. Each verb reaches
[the terminal moment](#the-terminal-moment) before it settles, so a caller that resumes from either
one holds a frozen `evidence`, an ended `lines`, and a settled `exit`.

| Method    | Returns            | Behavior                                                                                        |
| --------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `send`    | `Promise<boolean>` | Write one line to the open stdin channel; true when the host accepted the bytes.                |
| `stop`    | `Promise<boolean>` | Terminate the child tree and reach the terminal moment; true when the native exit was observed. |
| `destroy` | `Promise<void>`    | Stop the child, destroy stdin, then destroy the emitter last; the barrier every call shares.    |

#### `SessionInterface`

`write` puts raw bytes on the open stdin channel and `end` closes that channel; `stop` and `destroy`
are the lifecycle verbs. None of them rejects, and each of `end`, `stop`, and `destroy` returns one
stable barrier shared by every call. `stop` and `destroy` reach
[the terminal moment](#the-terminal-moment) before they settle. `end` does not, and that is the
distinction the member exists to carry: it closes the input channel and leaves the child running.

| Method    | Returns            | Behavior                                                                                        |
| --------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `write`   | `Promise<boolean>` | Write raw bytes to the open stdin channel, appending nothing; true when the host accepted them. |
| `end`     | `Promise<void>`    | Close the stdin channel and leave the child running; the barrier every call shares.             |
| `stop`    | `Promise<boolean>` | Terminate the child tree and reach the terminal moment; true when the native exit was observed. |
| `destroy` | `Promise<void>`    | Stop the child, destroy stdin, then destroy the emitter last; the barrier every call shares.    |

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

#### `ProcessChildInterface`

`kill` delivers one signal, and `once` and `off` register and release the one-shot `exit` or `close`
listener each bounded wait needs. A `ChildProcess` satisfies all three structurally, so a caller can
drive `stopChild`, `waitForExit`, and `waitForClose` over a child it spawned itself.

| Method | Returns   | Behavior                                                                              |
| ------ | --------- | ------------------------------------------------------------------------------------- |
| `kill` | `boolean` | Deliver one signal to the process; true when the host accepted it.                    |
| `once` | `unknown` | Register a one-shot `exit` or `close` listener; the emitter's own return, ignored.    |
| `off`  | `unknown` | Release one registered `exit` or `close` listener; the emitter's own return, ignored. |

#### `Supervisor`

`deliver` writes raw bytes to the open stdin channel and `end` closes that channel; `stop` and
`destroy` are the lifecycle verbs. None of them rejects. `Process` and `Session` each forward their
own member to one of these, so the engine's contract is the one both faces publish under their own
names.

| Method    | Returns            | Behavior                                                                                        |
| --------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `deliver` | `Promise<boolean>` | Write raw bytes to the open stdin channel, appending nothing; true when the host accepted them. |
| `end`     | `Promise<void>`    | Close the stdin channel and leave the child running; the barrier every call shares.             |
| `stop`    | `Promise<boolean>` | Terminate the child tree and reach the terminal moment; true when the native exit was observed. |
| `destroy` | `Promise<void>`    | Stop the child and release the composing face; the barrier every call shares.                   |

## Supervised children

`Process` spawns one child and captures both its streams. Standard output is framed through
`readline`, including a final line written without a trailing newline. A line feed, a CRLF pair, and
a bare carriage return each terminate a line, and a CRLF split across delivered chunks joins as one
break. A child that redraws a progress bar with a carriage return therefore yields one line per
redraw, and consecutive carriage returns yield an empty line between them. This line stream is the
package's progress surface: a consumer reads a child's progress off the lines it already receives,
so the package exposes no separate progress channel. Standard error is decoded
and forwarded live as the `stderr` event, while a byte-bounded raw tail is retained as `evidence` —
the diagnostic to attach to a failed exit. The typed `emitter` also carries the child `error` cause
on a spawn fault, a `ProcessError` coded `protocol` whose cause is a host-reported standard-input
fault, and the terminal `exit`, alongside the `exit` promise.

`ProcessOptions` requires `command` and `workspace`; the rest are optional:

| Option      | Type                            | Required | Meaning                                                                                                                                                                         |
| ----------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`   | `ProcessCommand`                | yes      | The executable, its argument vector, and optional environment overrides and stdin `input`.                                                                                      |
| `workspace` | `string`                        | yes      | The working directory the child runs in.                                                                                                                                        |
| `grace`     | `number`                        | no       | POSIX milliseconds between `SIGTERM` and `SIGKILL`. Default: `PROCESS_GRACE` (`5_000`).                                                                                         |
| `drain`     | `number`                        | no       | Milliseconds the package waits for the child's read ends to close after its ending, before cutting them off; `0` cuts them off immediately. Default: `PROCESS_DRAIN` (`1_000`). |
| `evidence`  | `number`                        | no       | Maximum retained stderr tail in bytes. Default: `PROCESS_EVIDENCE` (`2_048`).                                                                                                   |
| `backlog`   | `number`                        | no       | Soft high-water mark in bytes; termination retains at most twice `backlog`. Default: `PROCESS_BACKLOG`.                                                                         |
| `delivery`  | `number`                        | no       | Milliseconds an unconfirmed `send` waits before resolving `false`; `0` or omitted disables the bound.                                                                           |
| `writable`  | `boolean`                       | no       | When `true`, stdin stays open for `send`; when `false` or omitted, stdin closes after any initial `input`.                                                                      |
| `signal`    | `AbortSignal`                   | no       | Aborting this signal terminates the child through the same bounded `stop`.                                                                                                      |
| `on`        | `EmitterHooks<ProcessEventMap>` | no       | Initial `stderr`, `error`, and `exit` listeners installed at construction.                                                                                                      |
| `error`     | `EmitterErrorHandler`           | no       | Receives a listener's throw, isolated from the engine.                                                                                                                          |

There is no completion deadline for a running child. Nothing here ends a child that is still
working, the `exit` promise carries no deadline of its own, and a caller that wants one arms its own
timer and calls `stop`. `drain` does not weaken that: it bounds the window between the child's
ending and the release of its read ends. The child's native exit arms that window, and a termination
this package initiated arms it too, so every ending reaches the bound. The cutoff ends
observation; it does not terminate the child.

Every numeric option is validated at construction. A timer value outside `[0, PROCESS_TIMER]`, a
negative or fractional byte value, and a `backlog` below `1` each throw a `ProcessError` coded
`invalid` before anything is spawned, and so does a spawn-bound command string that is empty when
required or carries a NUL character. `input` is standard-input payload and carries no NUL
restriction.

Every option and command property is read once, before the child is spawned. Reading a property runs
whatever getter you put behind it, so hoisting those reads is what keeps a construction failure from
leaving a live child nobody holds: a getter that throws does so while nothing has started.

### Byte sessions

`Session` supervises the same child and publishes its standard output as raw bytes. Each chunk the
host delivers becomes one `stdout` event carrying an owned `Uint8Array` — the session's own copy, and
a plain `Uint8Array` rather than a Node `Buffer` — so you keep it, mutate it, and concatenate it
without reaching memory the host still manages and without depending on a host type. Nothing is
framed and nothing is decoded on that side. A chunk boundary is the host's, so one event is not one
message and a line feed inside a payload starts no new event; you frame the concatenated bytes
yourself. Standard error is decoded and forwarded as `stderr` with the same byte-bounded `evidence`
tail a `Process` retains, because a diagnostic stream is read rather than parsed.

Choose by what the child's output is. `Process` frames output a person or a log reads. `Session`
delivers output a parser reads — a length-prefixed protocol, a binary payload, anything a line framer
would corrupt.

`SessionOptions` is `ProcessOptions` without `backlog` and without `writable`. A session retains no
lines, so no backlog bound applies to it; its stdin channel is open from the spawn until `end` closes
it, so no switch selects whether one exists.

`SessionOptions` requires `command` and `workspace`; the rest are optional:

| Option      | Type                            | Required | Meaning                                                                                                                                                                         |
| ----------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`   | `ProcessCommand`                | yes      | The executable, its argument vector, and optional environment overrides and stdin `input`.                                                                                      |
| `workspace` | `string`                        | yes      | The working directory the child runs in.                                                                                                                                        |
| `grace`     | `number`                        | no       | POSIX milliseconds between `SIGTERM` and `SIGKILL`. Default: `PROCESS_GRACE` (`5_000`).                                                                                         |
| `drain`     | `number`                        | no       | Milliseconds the package waits for the child's read ends to close after its ending, before cutting them off; `0` cuts them off immediately. Default: `PROCESS_DRAIN` (`1_000`). |
| `evidence`  | `number`                        | no       | Maximum retained stderr tail in bytes. Default: `PROCESS_EVIDENCE` (`2_048`).                                                                                                   |
| `delivery`  | `number`                        | no       | Milliseconds an unconfirmed `write` waits before resolving `false`; `0` or omitted disables the bound.                                                                          |
| `signal`    | `AbortSignal`                   | no       | Aborting this signal terminates the child through the same bounded `stop`.                                                                                                      |
| `on`        | `EmitterHooks<SessionEventMap>` | no       | Initial `stdout`, `stderr`, `error`, and `exit` listeners installed at construction.                                                                                            |
| `error`     | `EmitterErrorHandler`           | no       | Receives a listener's throw, isolated from the engine.                                                                                                                          |

A session names the child's ending and the supervision's ending apart, because a transport acts on
each differently. `ending` settles at the child's own native exit and resolves no value: `code` and
`signal` already carry the terminal facts, so a second copy of them here could only drift from them.
`exit` settles at [the terminal moment](#the-terminal-moment), which is that native exit plus at most
`drain` while a descendant holds the inherited read ends. Race a cooperative shutdown window against
`ending`; a window raced against `exit` escalates against a child that already ended.

`end` closes the stdin channel and leaves the child running. That is the cooperative shutdown a
protocol client runs: end the input, let the child finish its own work, and terminate only when it
does not. It is the one member on either face that does not reach the terminal moment.

```ts
import { Buffer } from 'node:buffer'
import { createSession } from '@orkestrel/process/server'

const session = createSession({
	command: { file: 'node', arguments: ['-e', 'process.stdin.pipe(process.stdout)'] },
	workspace: process.cwd(),
})

const received: Uint8Array[] = []
session.emitter.on('stdout', (chunk) => received.push(chunk))

await session.write(new TextEncoder().encode('ping')) // true — the host accepted the bytes
await session.end() // the child sees end of input; nothing terminated it
await session.ending // it exited on its own

Buffer.concat(received).toString('utf8') // 'ping' — the exact bytes, with no terminator added
const exit = await session.exit
exit.code // 0
session.stopping // false — no termination was initiated
await session.destroy()
```

### The terminal moment

The child's ending and the supervision's ending are distinct, and telling them apart is what this
surface is shaped around.

- **The child's ending** is the host's own record of the process: `pid`, `code`, and `signal`. They
  carry the native exit as soon as the host records it.
- **The supervision's ending** is the terminal moment: `settled`, `exit`, `evidence`, and `lines`.
  They reach it together.

`Session` gives the child's ending a member of its own, `ending`, which settles at the native exit
and resolves no value. `Process` carries no such member: a line consumer reads that ending from
`code` and `signal`, which have always reported it.

The terminal moment arrives when the child's streams close, or when the `drain` bound elapses first.
The child's native exit arms that bound, and so does a termination this package initiated, so a
natural exit, a spawn fault, `stop`, `destroy`, and an abort of the `signal` option each reach the
moment. `ProcessExit.drained` reports which way it arrived: `true` for the close, `false` for the
cutoff.

The endings separate whenever a descendant inherited the child's stdio, because that descendant
holds the pipe open after the child itself is gone. Inside that window `code` and `signal` carry the
terminal pair while `exit` is still pending, so read the child's ending from those fields and the
supervision's ending from `settled`.

At the terminal moment every observation surface stops moving, together:

- `evidence` freezes and never moves again. Every later read returns the same string, so a consumer
  needs no private copy of the tail and cannot watch it move under them.
- `lines` ends rather than throwing, so teardown is not an error path: a pending `next` call resolves
  `done: true` and a `for await` loop exits normally. Every line already framed and queued is
  delivered before that end, so a consumer that stops a chatty child still reads what the child had
  framed. A cutoff loses more than the bytes that arrive after it: only a stream's own end flushes a
  trailing partial, so a final line the child wrote without a newline is dropped however early it
  was written.
- `exit` settles with its `ProcessExit` value, and `settled` turns `true`.
- The abort listener registered on the caller's `signal` option is released here, rather than at the
  `destroy` call that preceded it.

A `Session` reaches the same moment through the same paths, with its byte events in place of `lines`:
the last `stdout` and `stderr` events are delivered before the `exit` event, and none follows it.

`end` is the one member on either face that does not reach the moment. It closes a session's stdin
channel and leaves the child running, so `stopping` stays false, no drain window is armed, and `exit`
stays pending until the child ends itself or something terminates it. Every other verb here ends the
observation; `end` ends only the input.

`stop` reaches the terminal moment as well as `destroy` does. A caller that terminates a child and
keeps reading it therefore reaches the end of the stream instead of waiting on a child it already
ended, and needs no second call to release it. `stopping` reports the initiation rather than the
arrival: it turns `true` when `stop`, `destroy`, or an abort of `signal` begins a termination, and it stays
`true` from then on, including after `settled` turns `true`. A child that exited on its own reports
`stopping` as `false` with `settled` as `true`.

A consumer handed the terminal value never reads a child that still reports itself unfinished. The
latch runs before the `exit` event and before the read ends are released, so a listener on that
event reads `settled` as `true` from inside the delivery that handed it the value.

`drained` lives on `ProcessExit` rather than on the child, because that value exists only at the
terminal moment. A getter would admit a read before the moment arrives, which is the defect this
contract removes.

```ts
import { createProcess } from '@orkestrel/process/server'

const child = createProcess({
	command: { file: 'node', arguments: ['-e', 'console.error("done")'] },
	workspace: process.cwd(),
	drain: 1_000, // the bound on the wait for the child's read ends to close
})

const exit = await child.exit
exit.drained // true — the child's own streams closed
child.settled // true — evidence is frozen and lines has ended
child.stopping // false — this child ended on its own
child.evidence // 'done\n' — the frozen tail every later read returns
await child.destroy()
```

#### The drain bound

`drain` bounds how long the package waits for the child's read ends to close, and defaults to
`PROCESS_DRAIN`. The TSDoc on that constant carries the measurement behind the value and the date it
was taken.

Two moments arm the bound. The child's native exit arms it, which is what carries a natural exit to
the terminal moment when a descendant holds the read ends open. The return of a termination this
package initiated arms it too, confirmed or not, so a `stop` whose confirmation window elapsed while
the child was still running reaches the cutoff with `code` and `signal` still `null`.

The close latency is bimodal rather than long-tailed, so `drain` is a bound on the unbounded case
and not a percentile of a distribution. Measured on Windows 11 with Node v24.18.1 on 2026-08-21,
every ordinary close landed within 0.02ms of the native exit, and a `taskkill /F /T` that reaped a
descendant while the root was still alive closed within 0.01ms. Every late close in that fixture set
came from a descendant holding the inherited pipe: one that ends on its own closes late by its own
remaining life, and one that never ends never closes at all. There is no finite tail for a
percentile to cover.

Pass `drain: 0` for an immediate cutoff. That reads against the sibling `delivery`, whose `0`
disables its bound, and the difference is deliberate: an unbounded drain is the defect `drain`
exists to prevent, so no value requests one.

Read `drained` when the diagnostics matter. `drained: true` reports that the child's streams closed,
so `evidence` holds everything the child wrote. `drained: false` reports that the bound elapsed
first, so `evidence` is the tail as of the cutoff and later diagnostics may have existed. `drained`
and `truncated` are independent facts about different streams, and one child reports both when a
retention bound dropped stdout lines and the drain bound cut stderr off.

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

A retained line costs its payload bytes plus one byte for the break that framed it, whichever
terminator the child wrote, so a line carrying no payload still costs a byte. That is what bounds a
flood of empty lines, which would otherwise be free and defeat the mark entirely.

### Standard input

`writable: true` keeps stdin open for `send`. `send` never rejects and never throws: it resolves
`true` when the host accepted the bytes without reporting a fault, and `false` when the channel was
closed, destroyed, ended, failed, or left the write unconfirmed through `delivery`. Acceptance is a
fact about the host's pipe rather than about the child: it does not prove that the child read the
bytes, and it does not prove that the child ever will.

After `stop` or `destroy` begins, a later `send` call resolves `false`. Version 0.0.4 could resolve
that call `true` before teardown destroyed the pipe. The narrower answer avoids claiming delivery
for bytes the package is about to discard.

A host-reported fault on the channel surfaces rather than being swallowed. The affected `send`
resolves `false`, and the `error` event carries a `ProcessError` coded `protocol` whose `cause` is
the host fault, so a message lost to a dying child is an event you can act on. The channel holds one
failure state: the write callback and the stream error report the same fault once, and every later
`send` resolves `false` with no further event.

A channel the package or consumer has ended stays quiet for its remaining life. A `stop`, a
`destroy`, or a channel that was never writable settles every pending write `false` and emits
nothing. The constructor-supplied `input` write and its closing `end` form the initial input phase;
a fault arising from that sequence also emits nothing and creates no channel-failure state. Only a
`writable: true` channel that has not yet ended surfaces a later host fault as `protocol`.

An ordinary write settles as soon as the kernel accepts it. A write larger than the host's pipe
buffer to a child that never reads it can fill the pipe and remain unconfirmed. `delivery` bounds
that wait: an unconfirmed write resolves `false` after the given milliseconds, and no event fires,
because the bound expiring is not a fault the host reported. Omit `delivery`, or pass `0`, and the
write stays pending until the channel faults or teardown settles it.

Neither mechanism proves delivery, so a consumer that needs a deadline still arms its own timer and
calls `stop`. On Windows 11 with Node v24.18.1, measured on 2026-08-21, a child that closes its own
file descriptor 0 can leave the parent's pipe writable: `send` resolves `true` and no fault is ever
reported while that child stays alive, so `true` there records bytes taken into a pipe nobody will
read. After that child exits, `send` resolves `false` because the channel is closed, and a write
still pending when it exits fails with the host's `EOF` and arrives as the `protocol` error.

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

await echo.send('ping') // true — the host accepted the bytes
await echo.stop() // true — the native exit was observed
await echo.destroy()
```

A `Session` opens the same channel with no switch and writes to it with `write` rather than `send`.
`write` puts the exact bytes on the channel and appends nothing, so a caller framing its own protocol
composes the header and the delimiter itself. Every refusal above holds for `write` unchanged: it
never rejects, and it resolves `false` for a channel that was closed, destroyed, ended, or failed,
for a write left unconfirmed through `delivery`, and for a call made after `stop` or `destroy` began.
The host can queue the payload, so treat the array you passed as owned by the channel until the
returned promise settles.

`end` closes a session's channel without terminating anything. Every call shares one barrier, which
resolves after the host flushes the writes it had already accepted. That flush carries no bound of
its own: a child that stops reading its input leaves the accepted bytes in the pipe, and the barrier
stays pending for as long as they sit there. Race `end` against a window of your own when you need a
bound, the way [Close a byte session cooperatively](#close-a-byte-session-cooperatively) does, rather
than awaiting it bare. A `write` after `end` resolves
`false`, because the host stops reporting an ended channel writable — that refusal is derived from
the channel's state rather than declared by a second flag. The ended channel then stays quiet for its
remaining life, exactly as a package-ended one does: a later host fault on it settles pending writes
and emits no `error` event.

`ProcessInterface` carries no `end`, because a `Process` fixes its channel's lifetime at
construction. `writable: false` or omitted closes stdin after any initial `input`, and `writable:
true` keeps it open until termination.

### Termination

`stop` terminates the child tree, awaits its observed exit, and reports whether that exit arrived. It
resolves `true` when the child's native exit was observed and `false` when the confirmation wait
elapsed without it. Every call shares one termination, and the liveness fields are read again before
each signal, so no signal is initiated after an observed exit. The window between initiating a
signal and the host delivering it belongs to the operating system, which is the limit of what any
caller can hold. `destroy` runs `stop`, destroys stdin so every pending `send` settles, then destroys
the emitter last; it always resolves, including when termination was never confirmed.

`stop` and `destroy` each settle after [the terminal moment](#the-terminal-moment), bounded by
`drain`, so a descendant holding an inherited pipe cannot hold either one open. `destroy` destroys the emitter
after the frozen state exists, so a consumer watching the `stderr` event and a consumer reading
`evidence` end on the same bytes.

`Session` terminates through the same two verbs with the same bounds and the same barriers. Run its
cooperative shutdown first where the child supports one: call `end`, race `ending` against a window
of your own, and call `stop` when that window expires.

POSIX detachment creates the process group that tree termination signals. The child therefore
survives the supervisor's `SIGKILL` and does not receive the terminal's `SIGINT`. Call `stop` or
`destroy` during an orderly shutdown.

No bounded wait leaks a listener. `destroy` removes the abort listener it registered on the caller's
`signal`, so a long-lived controller does not accumulate one per child; the release happens at the
terminal moment, which is where every other observation surface is released, rather than at the
`destroy` call. `waitForExit` releases its own `exit` listener when its deadline elapses before the
exit, and `waitForClose` releases its own `close` listener the same way, so a child driven through
several bounded waits accumulates none either. `ProcessChildInterface` declares the `off` that
release needs, so a caller composing a stop of its own from the published contract releases it too.

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

`stopChild` therefore returns for an already-exited child before any route to its pid runs, on every
host. The host has reaped that number and can have handed it to another process, so signalling it or
naming it to `taskkill` reaches a process this package never spawned. Nothing recoverable is given
up by returning: measured on Windows 11 with Node v24.18.1 on 2026-08-21, `taskkill /F /T` against a
live root reaped every descendant in the fixture set, and against an exited root it reported the
process as not found while the descendant kept the pipe open and delivered for a further 2.28s. A
descendant whose root has exited is beyond every mechanism here, and the `drain` bound is what ends
the wait for it.

After an undrained cutoff, no mechanism here can report whether further diagnostics existed, and that
is a limit rather than an omission. Node exposes no count of the writers still holding a pipe, and a
descendant that outlives its root is beyond `taskkill /F /T`, so nothing observable settles the
question. `drained: true` carries no such limit: the read ends closed, so `evidence` holds everything
the child wrote. Start a teardown while the root is still alive to keep the ordinary case on that
branch.

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
before the terminal moment whenever a descendant holds the child's stdio open, so a supervisor
inside that window reads the child's own ending from them. A spawn fault records the host's negative
errno as the `code`, the same value the `exit` promise carries.

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
const { drained } = await child.exit // false when the drain bound cut the streams off
console.log(child.evidence) // the frozen stderr tail, at most PROCESS_EVIDENCE bytes
console.log(drained)
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

The `execute` function writes `input` with a host callback. A fault while that write is pending ends
the run by design and makes `failed` true. With `strict: true`, the rejection is coded `input`, its
message states that standard-input writing failed, and it carries the host fault as its `cause`;
with `strict: false`, the result carries no cause member. This behavior is distinct from the quiet
constructor input phase of `Process`.

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

`failed` is derived: a run failed when it timed out, was aborted, ended on a host fault, was ended by
a signal, or exited with a code other than `0`. A `null` code from a spawn fault is therefore a
failure, an abort is a failure, and a synchronous overflow is a failure. `expired` and `aborted` are
the ways the run ended the child rather than the child ending itself, and only the earliest observed
is recorded, so they are mutually exclusive. For a `strict: false` caller, `failed: true` with
`expired`, `aborted`, and `truncated` false, `code: 0`, and `signal: null` is the residual signature
that a host fault ended the run.

A spawn fault reports the host's negative errno in `ProcessExit.code` and an asynchronous
`ExecuteResult.code`. The synchronous `executeSync` result reports `null` instead.

By default a failed run rejects with a `ProcessError` carrying the `ExecuteResult` on its `result`
property. An expired run carries code `timeout`, and a host fault while writing standard input
carries code `input`; every other failure carries code `spawn`. Passing `strict: false` settles with
the result even on failure, so you inspect `failed` yourself.

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

`execute` captures one byte past that bound, so the final trim reads the first excluded byte and
retreats off a sequence the cut split. `executeSync` hands `limit` to the host as `maxBuffer` and
arrives at the same place from the other side: a child that overruns that ceiling still returns the
bytes the host had already read, which reach past `limit`, so the trim has its excluded byte there
too. Neither function returns a split sequence, and the returned text is bounded by `limit` in each
case. `captureChunk` applies the per-chunk bound `execute` captures under:

```ts
import { Buffer } from 'node:buffer'
import { captureChunk } from '@orkestrel/process/server'

captureChunk(Buffer.from('hello'), 3)?.toString('utf8') // 'hel'
captureChunk('hello', 3) // undefined
```

One `truncated` flag covers both streams, so a consumer that parses `stdout` structurally cannot
tell from the result which stream overflowed. Nothing in the result recovers that: both captured
strings are trimmed to `limit`, so a stream that stopped exactly at the cap and a stream that ran
past it read the same length. Where the distinction matters, re-run with a `limit` high enough that
`truncated` is `false`, then compare each captured length against the original bound — or supervise
the child with `Process`, which bounds `lines` and `evidence` separately.

`execute` keeps reading past the cap, discards the excess, and reports `truncated` without failing
the run. `executeSync` has no such option: the host ends the child with `SIGKILL` when the overflow
arrives, so its result reports `truncated` and `failed` together, with the partial output trimmed to
`limit`.

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
  launch is still refused. The `protocol` refusal throws synchronously, and the `destroy` barrier
  covers that child's teardown, so the refused child reaches its terminal moment before the barrier
  resolves.
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

| Code        | Raised when                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `spawn`     | A rejecting run failed outside its own timeout or input write.                                            |
| `timeout`   | A rejecting run's own `timeout` elapsed before completion.                                                |
| `input`     | `execute` alone: a rejecting run's standard-input write reported a host fault.                            |
| `duplicate` | `ProcessManager.launch` reused an id that is already live.                                                |
| `protocol`  | `ProcessManager.launch` ran after `destroy` began, or a supervised channel's open stdin reported a fault. |
| `invalid`   | A public input was refused before anything was spawned.                                                   |

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

`createExecuteError` constructs rejecting run failures other than standard-input write faults, and
`buildExecuteResult` assembles the result each error carries.

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

`Process`, `Session`, and `ProcessManager` each expose a typed `emitter` for fire-and-forget
observers — logging, metrics, tracing. Subscribe through `child.emitter.on(...)` or
`manager.emitter.on(...)`, or wire initial listeners through the `on` option; supply an `error`
handler to receive a listener's throw. The `error` handler and the `error` event are distinct: the
handler receives a listener's own throw, while the `error` event carries a child or channel fault.
Emitting is observation-only: every event fires after the transition it reports, and a throwing
listener is isolated and routed to the `error` handler, never onto a domain event, so a faulty
observer cannot corrupt the engine.

| Event map                | Events                                                            |
| ------------------------ | ----------------------------------------------------------------- |
| `ProcessEventMap`        | `stderr(chunk)` · `error(cause)` · `exit(exit)`                   |
| `SessionEventMap`        | `stdout(chunk)` · `stderr(chunk)` · `error(cause)` · `exit(exit)` |
| `ProcessManagerEventMap` | `launch(id)` · `exit(id, exit)`                                   |

A `Process` emits `stderr` for each decoded standard-error chunk, `error` when the child fails to
spawn, when the child itself errors, and when the host reports a fault on the standard-input
channel after the constructor input phase, and `exit` once, with the terminal `ProcessExit`, when
the child settles. A spawn or child fault carries its cause directly; a standard-input fault carries
a `ProcessError` coded `protocol` whose `cause` is the host fault. A fault arising from constructor
`input` or its closing `end` stays quiet. A spawn fault emits `error` and then still resolves `exit`. A
`ProcessManager` emits `launch` when a child joins the registry and `exit`, with the child's id and
terminal state, when it settles and leaves.

A `Session` emits the same `stderr`, `error`, and `exit` moments, and adds `stdout` for each chunk of
raw bytes the host delivered. The `stdout` payload is the session's own owned array, so a listener
can keep it past the call, and no `stdout` event follows the `exit` event.

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
for await (const line of child.lines) console.log(line) // ends at the terminal moment
await child.exit
await child.destroy()
```

The abort reaches the terminal moment through the same bounded `stop`, so the loop exits on its own
and the `exit` promise is already settled when the loop returns.

### Close a byte session cooperatively

```ts
import { createSession } from '@orkestrel/process/server'

const session = createSession({
	command: { file: 'node', arguments: ['language-server.js', '--stdio'] },
	workspace: process.cwd(),
})

// …on shutdown: end the input, give the child a window of your own, then terminate if it overruns.
const window = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000))
const flushed = await Promise.race([session.end().then(() => true), window])
const finished = flushed ? await Promise.race([session.ending.then(() => true), window]) : false
if (!finished) await session.stop()
await session.destroy()
```

The window covers `end` as well as the child's own exit, because the flush `end` awaits carries no
bound: a child that stopped reading its input leaves the accepted bytes in the pipe, and awaiting
that barrier bare waits on them indefinitely.

The window is yours rather than the package's. `grace` bounds the gap between `SIGTERM` and
`SIGKILL` once a termination starts, and `drain` bounds the wait for the read ends afterwards;
neither one bounds how long you let a child finish work it was already doing.

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
whole sequence, and it is host-aware. It returns for a child that has already exited before any
route to its pid runs, because the host has reaped that number and can have handed it to another
process. A descendant whose root exited between your decision and that liveness read is therefore
unreachable, on either host; `drain` is what bounds the wait for it.

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

`stopChild` reports the child's own ending. Pair it with `waitForClose` to reach the supervision's
ending over a child you spawned yourself, and register that wait before the termination so a close
landing between them is still observed.

```ts
import { spawn } from 'node:child_process'
import { stopChild, waitForClose } from '@orkestrel/process/server'

const collector = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 50)'], {
	detached: process.platform !== 'win32',
})

const closing = waitForClose(collector, 1_000) // registered before the termination
await stopChild(collector, 5_000, 5_000)
const closed = await closing
closed // true when the streams closed inside the bound
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
- **Reach for `Session` when the child speaks a protocol** — `lines` frames text, and a
  length-prefixed header, a binary payload, or a NUL byte survives no line framer. A session hands
  you the exact bytes and lets you frame them.
- **Close a session with `end`, then race `ending`, then `stop`** — `end` closes the input and
  terminates nothing, `ending` reports the child's own exit, and `stop` is the escalation for a child
  that overruns the window you gave it. Race `ending` rather than `exit`: `exit` waits out `drain`
  for a descendant holding the pipe, so a window raced against it escalates against a child that
  already ended.
- **Give `execute` a `timeout` when the command can start a descendant** — an unbounded run waits on
  stdio completion, and a descendant that inherited the child's pipes holds it open past the child's
  own exit.
- **Derive liveness before you address `pid`** — a live child is
  `pid !== undefined && code === null && signal === null`, and the host reuses a dead child's id, so
  a signal sent without that check reaches whatever process holds the id.
- **Read `evidence` on a failed exit** — the byte-bounded stderr tail is the diagnostic to attach,
  bounded by `evidence` (default `PROCESS_EVIDENCE`). It freezes at the terminal moment, so read it
  after `exit` settles and keep no copy of your own.
- **Read `drained` before you treat the diagnostics as complete** — `true` reports that the child's
  streams closed, so the diagnostics are everything the child wrote. `false` reports that the `drain`
  bound cut them off, and nothing can report whether more existed, because a descendant holding an
  inherited pipe is beyond the tree kill and the host counts no remaining writers.
- **Lower `drain` for a shutdown with a deadline of its own** — the default `PROCESS_DRAIN` bounds
  the wait for a descendant that never releases the pipe. Pass `drain: 0` to cut the streams off as
  soon as the bound is armed.
- **Observe, do not drive** — subscribe to `emitter` for lifecycle moments; emitting is a pure
  side-channel, so a listener never changes what the engine does.

## Vocabulary

Each name on this surface that reads against a house rule is settled here rather than rediscovered.

| Name                     | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute`, `executeSync` | Use the fixed lifecycle verb for primary work to completion. `executeSync` keeps the ecosystem `Sync` suffix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `detach`                 | Retained as a bare verb where the standalone-helper default reads `{verb}{Noun}`. The call site is unmistakable without the noun: `detach` takes a `ProcessCommand` and its own `DetachOptions`, and it is the one word for the spawn that is not awaited. `detachProcess` was refused for repeating the type the argument already carries.                                                                                                                                                                                                                                  |
| `process`, `processes`   | Retained. A registry exposes its contents as accessors named for what they hold, so the manager reads `manager.process(id)` and `manager.processes()`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `strict`                 | Replaces `reject`. A boolean reads as an adjective asserting a state, and `reject` named the reaction rather than the mode. `strict: false` resolves with the failed result.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `evidence`, `backlog`    | Byte bounds are named for their subject where an entity has several, so a `Process` carries `evidence` and `backlog` rather than flavours of `limit`. A run has one bound, so it is named for the bound: `limit`.                                                                                                                                                                                                                                                                                                                                                            |
| `truncated`              | One name on both surfaces, because it reports one fact: the surface omitted output. Each entity names its own bound — a `Process` omits `lines` past a retention bound, and an `ExecuteResult` omits captured text past `limit`.                                                                                                                                                                                                                                                                                                                                             |
| `run`                    | Kept as the English noun for one invocation — a terminated run, a run that stays pending. It never names a function; `execute` and `executeSync` are named by their identifiers, so the concept carries one term.                                                                                                                                                                                                                                                                                                                                                            |
| `settled`                | Derives literally: it is `true` exactly when `exit` has settled. `closed` was refused because it borrows a Node event name into `ProcessInterface`, which is host-independent enough to type `signal` as a `string`.                                                                                                                                                                                                                                                                                                                                                         |
| `stopping`               | A present participle for a latched fact, documented as monotonic rather than renamed. It reports that a termination was initiated, not that one is in flight, because the initiation is what a consumer acts on: a child that was asked to end is not a child to send new work to.                                                                                                                                                                                                                                                                                           |
| `drain`, `drained`       | The option names the window and the result names its outcome, so one concept carries one term across the two surfaces. `drain: 0` is an immediate cutoff rather than a disabled bound, unlike the sibling `delivery`, because an unbounded drain is the defect the option prevents.                                                                                                                                                                                                                                                                                          |
| `Session`                | A second entity rather than a byte mode on `Process`, because a mode would falsify `lines`, `truncated`, and `backlog` on half the instances of one class. `Child` collides with the published `ProcessChildInterface` contract, `Channel` is this package's word for the stdin pipe, and `Stream` and `Duplex` borrow Node class names into contracts typed to stay host-independent.                                                                                                                                                                                       |
| `Supervisor`             | The spawn, capture, channel, and termination engine `Process` and `Session` compose. It is barrelled because its constructor takes a `ProcessOptions` and a `SupervisorFace`, and a consumer holds both, so a consumer composing a third face of its own reaches the same engine `Process` and `Session` do.                                                                                                                                                                                                                                                                 |
| `SupervisorFace`         | The callback record a face hands the engine at construction, not a face and not the `Supervisor`'s own face. It carries `Face` rather than the `{Entity}Hooks` form `EmitterHooks` uses, because hooks are optional listeners on an entity that runs without them, while every callback here is a moment the engine must deliver. `{Entity}Interface` was refused because the type declares no behavior of its own: each member holds a function the composing face supplies. It is published because `types.ts` declares it and the server barrel star-exports that module. |
| `ending`, `exit`         | Two endings, named apart, because a transport acts on each differently. `ending` is the child's own exit and resolves no value, because `code` and `signal` already carry the facts and a second copy could only drift. `exit` stays on the terminal moment, so `exit`, `settled`, and the `exit` event name one moment on both faces.                                                                                                                                                                                                                                       |
| `end`                    | The consistency class of `destroy`: an idempotent lifecycle member returning the barrier every call shares. `close` was refused for borrowing a Node event name, the reason `settled` already records. It resolves `void` because every fact a result could carry is derivable — a later `write` reports `false`, and `ending` reports the exit.                                                                                                                                                                                                                             |
| `write`, `send`          | Different verbs because they promise different things. `send` frames a line and appends the terminator; `write` puts the exact bytes on the channel and appends nothing. One name over both would hide the terminator at the call site, which is the defect the split prevents.                                                                                                                                                                                                                                                                                              |
| `stdout`, `stderr`       | One face decodes one stream and not the other, because they are read differently. Standard output is a payload a parser consumes, so it stays bytes; standard error is a diagnostic a person reads, so it is decoded, and `evidence` bounds those same bytes.                                                                                                                                                                                                                                                                                                                |
| `backlog`, `writable`    | Omitted from `SessionOptions` rather than falsified on it. A session retains no lines, so no backlog bound applies; its channel is open until `end` closes it, so no switch selects whether one exists. An option that could only ever hold one value is a member a consumer must learn and can never use.                                                                                                                                                                                                                                                                   |

## Tests

Every proof that starts a real child runs in the `src:server` project, because spawning is this
package's server subject. Such a proof is an expensive one, and the fixed isolated projects carry
different subjects: the `distribution` project proves what the packed artifact installs, and the
`service` project proves a live external service. This package drives no external service, so it
declares no `service` project at all. Filing a spawn proof under either subject moves it out of the
default gate, and the package's own behavior then goes unproven until a publish.

Size every budget in a spawning suite — a case timeout, a termination wait, a condition budget —
from a full contended run rather than from an isolated one. Those suites start real children
concurrently, so each case pays for the children every other file starts beside it. On Linux with
Node v22.22.2 on 2026-08-25, `npm run test:src` reported a 6.94s wall duration over 12.86s of
aggregate test time, while the `tests/src/server/processes/ProcessManager.test.ts` file alone
reported 1.97s.
A budget sized from the isolated cost turns that contention into a red gate reporting a timeout, and
a timeout carries no diagnostic about the code.

The pure platform-decision rows execute both `win32` and POSIX inputs on every host. They cover
environment-key folding and merging, `PATHEXT` candidate order, batch routing, argument quoting, and
the percent-sign refusal. Those rows were last proven on Linux on 2026-08-20. The live POSIX rows
were also last proven on Linux on 2026-08-20, before the terminal-moment fixtures landed.

The live Windows filesystem, `cmd.exe`, and `taskkill.exe` rows execute on Windows only, and the
current fixtures were last proven on Windows on 2026-08-21. That run settles `killTree` through
`taskkill.exe` and grandchild tree termination through a live root. The unproven residue is the live
POSIX rows against those same fixtures, which cover the terminal moment, the drain cutoff, and the
descendant that outlives its root. On a POSIX host, settle them and re-run every server row with
this command:

```text
npx vitest run --config vite.config.ts --no-cache --project src:server
```

The standard-input fault rows execute on every host, and only their Windows reading has been taken,
on 2026-08-21. A write still pending when the child exits reports the host's `EOF` there and `EPIPE`
on POSIX, and both arrive through the same `protocol` error, so the rows assert that shape rather
than the errno. The POSIX `EPIPE` fast path is therefore the unproven residue, alongside the delivery
matrix and the line framing across the supported Node lines. A POSIX child that closes its own file
descriptor 0 is also expected to fault where the measured Windows child does not. On a POSIX host,
settle each with the same command.

The pure decision rows do not prove Windows end to end. They prove the decisions.

- [`tests/src/core/errors.test.ts`](../tests/src/core/errors.test.ts) — the error surface:
  `isProcessError` narrowing its own error and refusing a plain `Error`, the codes the guard admits
  compared against the declared `PROCESS_ERROR_CODES` tuple with a refusal control drawn from
  outside it, and recognition of an error constructed by another source copy of the module.
- [`tests/src/server/processes/Process.test.ts`](../tests/src/server/processes/Process.test.ts) —
  the supervised child:
  line framing across every terminator, a split CRLF pair, a carriage-return redraw, and a trailing
  partial line, the bounded backlog under each consumer policy and under a flood of empty lines, the
  byte-bounded `evidence` tail and live `stderr` event, `send` over an open and a closed channel, the
  `delivery` bound against its unbounded control, the `protocol` fault a host-reported channel
  failure raises beside the silence a package-initiated teardown keeps, bounded termination and its
  confirmation, the POSIX escalation from a trapped `SIGTERM` to `SIGKILL`, abort-signal termination,
  the isolated environment, the `invalid` refusals, and `destroy`. The terminal moment carries its
  own rows: the frozen `evidence` tail read against a descendant that keeps writing, the `stderr`
  event and the tail stopping together, `lines` ending an in-flight read after its queued lines, the
  `exit` promise settling at the cutoff when the streams never close, the `drain` bound driven below
  and above a descendant release, `stop` alone reaching the moment with no `destroy` call, the
  latched `stopping` refusing a `send`, the released abort listener, the spawn-fault path, and the
  `drain` refusals at each end of its range.
- [`tests/src/server/processes/Session.test.ts`](../tests/src/server/processes/Session.test.ts) —
  the byte face: a binary payload carrying NUL bytes, an invalid UTF-8 sequence, a lone carriage return, and an embedded line
  feed arriving byte-identical in one event, a half-megabyte stream reassembled byte for byte, and
  each emitted chunk read as a plain owned array against a raw spawn of the same child as the
  control. `write` echoing its exact bytes with no terminator added, refused after `end`, inside a
  `stop`, and after the child settles, bounded by `delivery` against an unbounded control, settled
  `false` by teardown with no event, and raising one `protocol` error on a host-reported channel
  fault. `end` leaving the child running against a reading child as the control, sharing one barrier,
  carrying a self-exiting child to both endings with no `stop` call, escalating to `stop` when the
  child overruns, keeping an ended channel quiet when a pending write later faults, and changing
  nothing after a `stop`. The endings pulled apart by a descendant holding the pipe, the `exit` event
  and promise agreeing once, the pid and the frozen `evidence` tail beside the live `stderr` chunks,
  the spawn-fault path, and the `invalid` refusals.
- [`tests/src/server/processes/Supervisor.test.ts`](../tests/src/server/processes/Supervisor.test.ts)
  — the engine driven through a literal face: the moment order that ends the face's read pipeline, freezes the
  terminal state, and only then releases the face; the backpressure release reaching a face holding
  a paused stdout before the termination sequence rather than after it; `ending` settling at the
  native exit while `exit` waits out the drain a descendant holds open; a `deliver` refused once a
  termination has begun; and the one barrier every `end` call shares, with the child ending itself
  because its input ended.
- [`tests/src/server/factories.test.ts`](../tests/src/server/factories.test.ts) — the
  interface-oriented constructors: each `create*` return carrying every member its interface
  declares, the construction options reaching the entity's own command and emitter rather than
  stopping at the factory, and the `backlog` refusal proven to precede the spawn against a control
  child whose marker dates one.
- [`tests/src/server/processes/ProcessManager.test.ts`](../tests/src/server/processes/ProcessManager.test.ts)
  — the registry: `launch` registration and its `duplicate`, `protocol`, and `invalid` refusals, including
  a teardown started from inside the caller's own option getter, the terminal moment of the child
  that refusal spawned arriving before the barrier resolves, the eviction of a child whose
  descendant holds the pipe at the drain cutoff, the unforgeable eviction and its ordering, the
  query surface, the `stop` overloads, and emitter-last `destroy`.
- [`tests/src/server/cloners.test.ts`](../tests/src/server/cloners.test.ts) — the command
  snapshot: each property read exactly once through a caller's own getter, the frozen argument
  vector and environment record a later mutation cannot reach, and the absent optional that stays
  absent rather than becoming an explicit `undefined`.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) — the building blocks
  and the spawns that compose them: the resolver under `PATHEXT` and an extension-bearing name, each
  platform input to the quoted batch builder and its percent-sign refusal, the environment merge
  under each platform input, the UTF-8-safe byte bounds retreating a cut to a code-point boundary,
  the per-chunk capture bound and the byte it keeps past `limit`, the validators, the termination
  helpers, and `waitForClose` across a close inside its deadline, a deadline that elapsed first, and
  the listeners it leaves behind. The runs carry their own rows: the asynchronous one-shot run's
  owned inputs, buffered outcomes, failure delivery, cancellation, timeout, capture bounds, spawn
  faults, and pre-spawn refusal; the blocking run's root-only timeout and argument integrity beside
  its own owned inputs, buffered outcomes, failure delivery, capture bounds, spawn faults, and
  pre-spawn refusal; and the fire-and-forget spawn's owned inputs, detached process-group behavior,
  invalid-input refusal, and the validated working directory.
- [`tests/guides.test.ts`](../tests/guides.test.ts) — this guide: every documented name resolves,
  every public export is documented, and every flagship fence returns what its comments claim.
- [`tests/distribution.test.ts`](../tests/distribution.test.ts) — the artifact a consumer installs:
  it packs the package, installs the tarball into a directory outside this repository, and compares
  the runtime exports of each built format against the declarations the compiler parses, under each
  supported `moduleResolution` mode.
- [`tests/setup.test.ts`](../tests/setup.test.ts) — `resolveChildFixture` and `childCommand`, the
  fixture command builders this suite spawns through: where the fixture resolves, and the argument
  vector each mode produces.
- [`tests/setupServer.test.ts`](../tests/setupServer.test.ts) — the same builders spawned for real:
  the fixture's own exit code, stdout, and stderr for a supplied detail, its own default when the
  caller omits one, and the argument vector reaching it unmodified.

## See also

- [`@orkestrel/emitter`](https://github.com/orkestrel/emitter#readme) — the typed push-observation
  primitive each `emitter` is built on.
- [`@orkestrel/contract`](https://github.com/orkestrel/contract#readme) — the guard primitive
  `isProcessError` composes.
- [`AGENTS.md`](../AGENTS.md) — the repository coding, naming, and lifecycle rules.
- [`README.md`](README.md) — the guides index.
