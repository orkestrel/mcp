# SSE

> A stateful Server-Sent-Events (SSE) stream parser: feed it string chunks, get
> back the complete events dispatched so far. SSE is a UTF-8 text stream of
> events separated by a blank line; within an event each `field: value` line
> accumulates onto an in-progress event — multiple `data:` lines concatenate
> with `\n`, `event:` / `id:` / `retry:` are last-wins — and a blank line
> DISPATCHES the accumulated event, but only when its data buffer is
> non-empty. A trailing partial line or in-progress event split across chunk
> boundaries is buffered until the rest arrives. The `id` / `retry` fields are
> also persisted as sticky connection state (WHATWG last-event-id semantics) —
> surfaced through the `id` / `retry` getters, cleared only by `reset()`. An
> optional `limit` bounds total buffered characters, throwing a typed
> `SSEError('OVERFLOW')` instead of growing unbounded; `flush()` forces out any
> trailing unterminated event at end-of-stream. A pure functional primitive —
> no Emitter, no server / HTTP / agent coupling; it never throws on malformed
> input, only `SSEError('OVERFLOW')` when a configured `limit` is exceeded.
> Source: [`src/core`](../../src/core). Surfaced through the `@src/core`
> barrel.

## Surface

Create a parser and feed it chunks as they arrive; each `parse(chunk)`
returns the events a blank line has dispatched so far, and an in-progress
event / trailing partial line is held for the next call:

```ts
import { createSSEParser } from '@orkestrel/sse'

const parser = createSSEParser()
parser.parse('data: a\ndata: b\n\n') // [{ data: 'a\nb' }] - the two data lines joined
parser.parse('event: ping\ndata: 1') // [] - the event is buffered until its blank line
parser.parse('\n\n') // [{ data: '1', event: 'ping' }]
parser.reset() // drop any buffered partial line / event - ready for a fresh stream
```

### Types

| Type                 | Kind      | Shape                                                                                                                         |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SSEEvent`           | interface | `{ data, event?, id?, retry? }` — one dispatched event; `data` is every `data:` field joined by `\n`, no trailing newline.    |
| `SSEParserInterface` | interface | The stateful stream-parser contract — `parse` / `flush` / `reset` + the sticky `id` / `retry` getters.                        |
| `SSEParserOptions`   | interface | `{ limit? }` — caps total buffered characters (un-consumed line buffer + in-progress event field lengths); unset → unbounded. |
| `SSEErrorCode`       | type      | `'OVERFLOW'` — the sole `SSEError` code, thrown when a configured `limit` would be exceeded.                                  |

```ts
import type { SSEParserOptions } from '@orkestrel/sse'

const options: SSEParserOptions = { limit: 1_000_000 }
```

### Constants

| API   | Kind  | Summary                                                                                                          |
| ----- | ----- | ---------------------------------------------------------------------------------------------------------------- |
| `NUL` | const | The NUL byte (`U+0000`) — an `id:` field containing it is voided per spec and never surfaced.                    |
| `BOM` | const | The byte-order mark (`U+FEFF`) — stripped from the very first chunk of a stream; ordinary content on later ones. |

```ts
import { BOM, NUL } from '@orkestrel/sse'

NUL.charCodeAt(0) // 0
BOM.charCodeAt(0) // 0xfeff
```

### Errors

| API          | Kind     | Summary                                         |
| ------------ | -------- | ----------------------------------------------- |
| `SSEError`   | class    | Carries an `SSEErrorCode` + optional `context`. |
| `isSSEError` | function | Narrow a caught value to an `SSEError`.         |

```ts
import { isSSEError, SSEError } from '@orkestrel/sse'

try {
	throw new SSEError('OVERFLOW', 'SSE parser buffer would exceed the configured limit', {
		limit: 100,
		size: 150,
	})
} catch (error) {
	if (isSSEError(error)) error.code // 'OVERFLOW'
}
```

### Factories

| API               | Kind     | Builds…                                                |
| ----------------- | -------- | ------------------------------------------------------ |
| `createSSEParser` | function | A working `SSEParserInterface`, backed by `SSEParser`. |

```ts
import { createSSEParser } from '@orkestrel/sse'

const parser = createSSEParser({ limit: 1_000_000 })
parser.parse('data: a\ndata: b\n\n') // [{ data: 'a\nb' }] - the two data lines joined
parser.parse('event: ping\ndata: 1') // [] - buffered until its blank line
parser.parse('\n\n') // [{ data: '1', event: 'ping' }]
```

### Entities

| API         | Kind  | Summary                                                                                             |
| ----------- | ----- | --------------------------------------------------------------------------------------------------- |
| `SSEParser` | class | The stateful SSE stream parser — implements `SSEParserInterface`, reassembles events across chunks. |

## Methods

The public methods of `SSEParserInterface` — the class's full method surface
(AGENTS §22). The `readonly` data members `id` / `retry` (sticky connection
state) stay off the method table below and are documented afterward.

#### `SSEParserInterface`

| Method  | Returns               | Behavior                                                                                                                                                                                                                                                 |
| ------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse` | `readonly SSEEvent[]` | Append `chunk`, then return every event a blank line has dispatched so far; a trailing partial line / in-progress event is buffered for the next call. Throws `SSEError('OVERFLOW')` when a configured `limit` would be exceeded — state left unchanged. |
| `flush` | `SSEEvent[]`          | Treat any remaining buffered partial line as terminated, then dispatch the in-progress event if its data buffer is non-empty. Returns a single-element array, or `[]` when nothing was pending.                                                          |
| `reset` | `void`                | Drop any buffered partial line, in-progress event, and persisted `id` / `retry` — full reset for a fresh stream.                                                                                                                                         |

```ts
import { SSEParser } from '@orkestrel/sse'

const parser = new SSEParser()
parser.parse('data: a\ndata: b\n\n') // [{ data: 'a\nb' }] - the two data lines joined
parser.parse('event: ping\ndata: 1') // [] - the event is buffered until its blank line
parser.parse('\n\n') // [{ data: '1', event: 'ping' }]
parser.reset() // drop any buffered partial line / event / persisted id/retry - ready for a fresh stream
parser.parse('data: fresh\n\n') // [{ data: 'fresh' }]
```

`flush()` is a convenience beyond the WHATWG algorithm, which discards an
unterminated final event at end-of-stream — without calling `flush()`, that
spec-faithful discard is the parser's default behavior:

```ts
import { SSEParser } from '@orkestrel/sse'

const parser = new SSEParser()
parser.parse('data: incomplete') // [] - no blank line yet, buffered
parser.flush() // [{ data: 'incomplete' }] - forced out at end-of-stream
```

`id` / `retry` are sticky connection state (WHATWG last-event-id semantics):
each valid `id:` / `retry:` field updates them, dispatch does NOT clear them,
and only `reset()` does — useful for reconnection (`Last-Event-ID` header):

```ts
import { SSEParser } from '@orkestrel/sse'

const parser = new SSEParser()
parser.id // undefined - no id: field seen yet
parser.parse('id: 42\nretry: 3000\ndata: x\n\n') // [{ data: 'x', id: '42', retry: 3000 }]
parser.id // '42' - persisted, survives dispatch
parser.retry // 3000 - persisted, survives dispatch
parser.reset()
parser.id // undefined - reset() clears sticky state
```

A configured `limit` throws a typed `SSEError` instead of growing the buffer
unbounded:

```ts
import { isSSEError, SSEParser } from '@orkestrel/sse'

const parser = new SSEParser({ limit: 10 })
try {
	parser.parse('x'.repeat(20))
} catch (error) {
	if (isSSEError(error) && error.code === 'OVERFLOW') parser.reset()
}
```
