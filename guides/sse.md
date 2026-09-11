# SSE

> A stateful Server-Sent-Events (SSE) stream parser: a handle that turns string chunks into
> the complete events a blank line has dispatched, buffering a partial line or in-progress
> event until the rest arrives and persisting the sticky `id` / `retry` connection state.

SSE is a UTF-8 text stream of events separated by a blank line. Within an event each
`field: value` line accumulates onto an in-progress event — multiple `data:` lines concatenate
with `\n`, and `event:` / `id:` / `retry:` are last-wins — and the blank line dispatches the
accumulated event, but only when its data buffer is non-empty. The `id` and `retry` fields
follow WHATWG last-event-id semantics: each survives dispatch, is read through the getter of
its own name, and is dropped only by `clear()`. An optional `limit` bounds the total buffered
characters, throwing a typed `SSEError('OVERFLOW')` rather than growing unbounded, and
`flush()` forces out a trailing unterminated event at end-of-stream. A pure functional
primitive — no Emitter, no server / HTTP / agent coupling; it never throws on malformed input,
only `SSEError('OVERFLOW')` when a configured `limit` is exceeded.
Source: [`src/core`](../src/core). Surfaced through the `@src/core` barrel.

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
parser.clear() // drop any buffered partial line / event - ready for a fresh stream
```

### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Type                 | Kind      | Shape                                    | Summary                                                                                                                                                                                                                                                                                                           |
| -------------------- | --------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SSEEvent`           | interface | `{ data, event?, id?, retry? }`          | Represents one dispatched Server-Sent Event — the value a blank line flushes from an `SSEParserInterface`. Its `data` holds every `data:` field of that event joined by `\n` with no trailing newline, and `event` / `id` / `retry` hold the last field of each name the event carried.                           |
| `SSEParserInterface` | interface | `{ id, retry } plus parse, flush, clear` | Represents a stateful Server-Sent-Events (SSE) stream parser: feed it string chunks, get back the complete events dispatched so far. A trailing partial line / in-progress event is buffered until the rest arrives, and the sticky `id` / `retry` getters carry the connection state a dispatch leaves in place. |
| `SSEParserOptions`   | interface | `{ limit? }`                             | Configures the parser `createSSEParser` builds and the `SSEParser` constructor accepts — `limit` caps the total buffered characters held at once, and leaving it unset keeps the buffering unbounded.                                                                                                             |
| `SSEErrorCode`       | type      | `'OVERFLOW'`                             | Names the machine-readable code an `SSEError` carries — `'OVERFLOW'` alone, thrown when a `parse(chunk)` call would push the buffered total over a configured `limit`.                                                                                                                                            |

```ts
import type { SSEParserOptions } from '@orkestrel/sse'

const options: SSEParserOptions = { limit: 1_000_000 }
```

### Constants

A `Shape` cell holds the constant's declared type.

| API   | Kind  | Shape  | Summary                                                                                                                                              |
| ----- | ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUL` | const | string | Names the null byte (`U+0000`). The SSE spec voids an `id:` field whose value contains it, so an `id` carrying a NUL is never surfaced.              |
| `BOM` | const | string | Names the byte-order mark (`U+FEFF`), stripped from the first non-empty chunk of an SSE stream (a leading mark on later chunks is ordinary content). |

```ts
import { BOM, NUL } from '@orkestrel/sse'

NUL.charCodeAt(0) // 0
BOM.charCodeAt(0) // 0xfeff
```

### Errors

| API          | Kind     | Summary                                                                                                                                                       |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SSEError`   | class    | Represents an error the SSE parser throws, carrying the machine-readable `SSEErrorCode` a `catch` branches on and an optional `context` of diagnostic detail. |
| `isSSEError` | function | Narrows an unknown caught value to an `SSEError`.                                                                                                             |

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

| API               | Kind     | Summary                                                                                                                                                                                |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSSEParser` | function | Creates a Server-Sent-Events (SSE) stream parser — a stateful `SSEParserInterface` handle, backed by `SSEParser`, that turns string chunks into the complete events dispatched so far. |

#### Create a bounded parser and feed it chunks

The following builds a parser bounded by `limit` and feeds it chunks as they arrive:

```ts
import { createSSEParser } from '@orkestrel/sse'

const parser = createSSEParser({ limit: 1_000_000 })
parser.parse('data: a\ndata: b\n\n') // [{ data: 'a\nb' }] - the two data lines joined
parser.parse('event: ping\ndata: 1') // [] - buffered until its blank line
parser.parse('\n\n') // [{ data: '1', event: 'ping' }]
```

### Classes

| API         | Kind  | Summary                                                                                                                                                                                                                         |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SSEParser` | class | Implements `SSEParserInterface` over one internal line buffer, reassembling an event split across chunk boundaries once its blank line arrives and holding the sticky `id` / `retry` connection state until `clear()` drops it. |

## Methods

The public methods of `SSEParserInterface` — the class's full method surface
(AGENTS.md, Documentation contract). The `readonly` data members `id` / `retry`
(sticky connection state) stay off the following method table and are documented
after it.

#### `SSEParserInterface`

| Method  | Returns               | Summary                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse` | `readonly SSEEvent[]` | Appends `chunk`, then returns every event a blank line has dispatched — each event's `data:` fields concatenated with `\n`, plus the last `event:` / `id:` / `retry:` field it carried. An in-progress event and a trailing partial line are retained for the next call, and a call that would exceed a configured `limit` throws instead, leaving parser state unchanged. |
| `flush` | `readonly SSEEvent[]` | Treats any remaining buffered partial line as if it had been terminated, then dispatches the in-progress event when its data buffer is non-empty.                                                                                                                                                                                                                          |
| `clear` | `void`                | Drops any buffered partial line, in-progress event, and persisted `id` / `retry`, leaving the parser ready for a fresh stream.                                                                                                                                                                                                                                             |

```ts
import { SSEParser } from '@orkestrel/sse'

const parser = new SSEParser()
parser.parse('data: a\ndata: b\n\n') // [{ data: 'a\nb' }] - the two data lines joined
parser.parse('event: ping\ndata: 1') // [] - the event is buffered until its blank line
parser.parse('\n\n') // [{ data: '1', event: 'ping' }]
parser.clear() // drop any buffered partial line / event / persisted id/retry - ready for a fresh stream
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
each valid `id:` / `retry:` field updates them, dispatch does not clear them,
and only `clear()` does — useful for reconnection (`Last-Event-ID` header):

```ts
import { SSEParser } from '@orkestrel/sse'

const parser = new SSEParser()
parser.id // undefined - no id: field seen yet
parser.parse('id: 42\nretry: 3000\ndata: x\n\n') // [{ data: 'x', id: '42', retry: 3000 }]
parser.id // '42' - persisted, survives dispatch
parser.retry // 3000 - persisted, survives dispatch
parser.clear()
parser.id // undefined - clear() drops sticky state
```

A configured `limit` throws a typed `SSEError` instead of growing the buffer
unbounded:

```ts
import { isSSEError, SSEParser } from '@orkestrel/sse'

const parser = new SSEParser({ limit: 10 })
try {
	parser.parse('x'.repeat(20))
} catch (error) {
	if (isSSEError(error) && error.code === 'OVERFLOW') parser.clear()
}
```

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection (value and type exports), the `SSEParserInterface` ↔ `SSEParser` method bijection, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Create a bounded parser and feed it chunks` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences and asserts the values their comments claim.
- [`tests/src/core/SSEParser.test.ts`](../tests/src/core/SSEParser.test.ts) — the parser against the WHATWG algorithm: dispatch on the blank line, stripping only the first space after a colon, multi-line `data:` concatenation with no trailing newline, every field together with last-wins repeats, comment and unknown-field handling, the empty-data rule that emits no spurious event, cross-chunk reassembly, LF / CRLF / bare-CR terminators including a CRLF split across chunks, first-chunk BOM stripping, integer-only `retry:`, a NUL-voided `id:`, sticky `id` / `retry` surviving dispatch until `clear()` drops them, `clear()` dropping the buffered line and the carriage hold and re-arming BOM stripping, returned arrays never aliased across calls, a configured `limit` throwing `SSEError('OVERFLOW')` with parser state unchanged, unicode and adversarial input, volume runs, and the invariant suites that feed one corpus through every fixed-size and two-way-split chunking and require the whole-string parse back.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — `createSSEParser` returns a working `SSEParserInterface`, hands back handles that share no buffer state, matches `new SSEParser()` over a shared corpus, and threads `limit` through to the same overflow.
- [`tests/policy.test.ts`](../tests/policy.test.ts) — this repository's own conventions: the scratch containment guard, the mirror register pairing each test with its module, the population controls with their negative controls, the skill family and bridge rules, the rule map, portability, the prose denylist and its currency, and the policy configuration wiring.
- [`tests/config.test.ts`](../tests/config.test.ts) — the root configuration read from the real config files, the Oxlint policy plugin's rules driven through `RuleTester`, and the configuration helpers.
