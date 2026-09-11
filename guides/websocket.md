# WebSocket

> The server-native bidirectional transport: a lean, typed wrapper over a raw upgraded
> `node:stream` Duplex socket that speaks only the RFC 6455 wire protocol, owning the
> handshake, the masked and unmasked frame codec, ping and pong, and the close handshake,
> and surfacing every message on an owned `emitter`.

After an HTTP server hands you an upgraded socket, this wrapper turns that raw byte stream into a typed, observable connection, and its only runtime dependency is `@orkestrel/emitter`, which supplies the typed emitter; [`node:crypto`](https://nodejs.org/api/crypto.html) supplies the one handshake hash. The wrapper has no knowledge of MCP, JSON-RPC, reconnection, heartbeats, or any message schema — those belong to a _message_ transport built one layer up, and this is only the wire. The codec and the boundary guards are pure exported functions, pinned against [RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)'s worked byte vectors and malformed-input cases, and the [`NodeWebSocket`](#nodewebsocketinterface) class is the thin stateful driver that runs them over a [`node:stream`](https://nodejs.org/api/stream.html) Duplex. Keeping the codec pure and the wrapper minimal is the lean-native-wrapper discipline: a small typed surface over native power, with the hard parts exported as testable units. Source: [`src/server`](../src/server). Surfaced through the `@src/server` barrel.

## Surface

Take the raw socket an HTTP server hands an `upgrade` listener and pass it to `createNodeWebSocket`, which writes the handshake and echoes every message it receives:

```ts
import { createServer } from 'node:http'
import { createNodeWebSocket } from '@orkestrel/websocket'

// A node:http server hands every upgrade request a raw socket; this wrapper takes it
// from there. Passing the client's `sec-websocket-key` selects server mode — the
// wrapper writes the 101 handshake, marks the connection open, and decodes frames.
createServer().on('upgrade', (request, socket, head) => {
	const key = request.headers['sec-websocket-key']
	if (typeof key !== 'string') {
		socket.destroy()
		return
	}
	const ws = createNodeWebSocket({
		socket,
		key, // present => server mode + 101 handshake
		head, // any bytes that arrived bundled with the upgrade request
		on: { message: (text) => ws.send(`echo: ${text}`) }, // wire listeners at construction
	})

	ws.emitter.on('close', (code, reason) => console.log('closed', code, reason))
})
```

`send` writes a UTF-8 text frame (unmasked, because this is the server); the peer's reply arrives back as a `message`. Everything is driven off the one `emitter` — there are no callbacks to register beyond it.

Narrow the header before the call. `sec-websocket-key` is typed `string | undefined`, and omitting `key` is what selects client mode: the wrapper writes no 101 handshake and masks its frames, so a browser waiting for the handshake sees a connection that never opens. The guard turns a missing header into a refused socket instead.

### Factories

| API                   | Kind     | Summary                                                                                                                                       |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `createNodeWebSocket` | function | Creates a server-native WebSocket over a raw upgraded `node:stream` Duplex socket — server mode when a `key` is given, client mode otherwise. |

### Classes

| API             | Kind  | Summary                                                                                                                                                                                                                |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeWebSocket` | class | Implements the wrapper contract over a raw upgraded `node:stream` Duplex socket, driving the RFC 6455 handshake, the frame codec, auto-pong, and the close handshake, and surfacing every event on an owned `emitter`. |

### Errors

| API                | Kind     | Summary                                                                                                                                             |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebSocketError`   | class    | Represents an error the WebSocket wrapper throws for a refused caller-supplied value, carrying a machine-readable `code` and an optional `context`. |
| `isWebSocketError` | function | Checks whether a caught value is a `WebSocketError`, narrowing it so a `catch` can branch on `error.code`.                                          |

### Codec helpers

| API                         | Kind     | Summary                                                                                                                                                                |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `computeWebSocketAccept`    | function | Computes the `Sec-WebSocket-Accept` response value for an RFC 6455 upgrade.                                                                                            |
| `isWebSocketKey`            | function | Checks whether a value is a canonical RFC 6455 `Sec-WebSocket-Key`.                                                                                                    |
| `isWebSocketProtocol`       | function | Checks whether a value is one valid WebSocket subprotocol token.                                                                                                       |
| `parseWebSocketFrame`       | function | Decodes a single RFC 6455 frame from the front of a buffer, answering `undefined` while the buffer is incomplete so the caller accumulates and retries.                |
| `measureWebSocketFrame`     | function | Reads the declared payload length off the front of a buffer without buffering or reading the payload itself, answering `undefined` until the length field is complete. |
| `matchesWebSocketCanonical` | function | Checks whether the next frame uses the shortest valid RFC 6455 payload-length encoding, answering `undefined` until its length prefix is complete.                     |
| `parseUTF8`                 | function | Decodes a byte sequence as strict UTF-8, answering `undefined` when the sequence is malformed.                                                                         |
| `isCloseCode`               | function | Checks whether a numeric value is a close status code an RFC 6455 endpoint may receive (§7.4.1).                                                                       |
| `encodeWebSocketFrame`      | function | Encodes a single RFC 6455 frame to its wire bytes — the inverse of `parseWebSocketFrame`.                                                                              |

### Constants

A `Shape` cell holds the constant's declared type.

| API                                 | Kind  | Shape                 | Summary                                                                                                                                     |
| ----------------------------------- | ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBSOCKET_GUID`                    | const | `string`              | Names the accept GUID concatenated to a client's `Sec-WebSocket-Key` before the accept hash, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'.        |
| `WEBSOCKET_VERSION`                 | const | `string`              | Names the supported protocol version, '13'.                                                                                                 |
| `WEBSOCKET_OPCODE_TEXT`             | const | `number`              | Names the text frame opcode, 0x01.                                                                                                          |
| `WEBSOCKET_OPCODE_BINARY`           | const | `number`              | Names the binary frame opcode, 0x02.                                                                                                        |
| `WEBSOCKET_OPCODE_CONTINUATION`     | const | `number`              | Names the continuation frame opcode, 0x00.                                                                                                  |
| `WEBSOCKET_OPCODE_CLOSE`            | const | `number`              | Names the close frame opcode, 0x08.                                                                                                         |
| `WEBSOCKET_OPCODE_PING`             | const | `number`              | Names the ping frame opcode, 0x09.                                                                                                          |
| `WEBSOCKET_OPCODE_PONG`             | const | `number`              | Names the pong frame opcode, 0x0a.                                                                                                          |
| `WEBSOCKET_READY_CONNECTING`        | const | `WebSocketReadyState` | Names the connecting ready state, 0.                                                                                                        |
| `WEBSOCKET_READY_OPEN`              | const | `WebSocketReadyState` | Names the open ready state, 1.                                                                                                              |
| `WEBSOCKET_READY_CLOSING`           | const | `WebSocketReadyState` | Names the closing ready state, 2.                                                                                                           |
| `WEBSOCKET_READY_CLOSED`            | const | `WebSocketReadyState` | Names the closed ready state, 3.                                                                                                            |
| `WEBSOCKET_CLOSE_NORMAL`            | const | `number`              | Names the normal-closure status code, 1000.                                                                                                 |
| `WEBSOCKET_CLOSE_PROTOCOL`          | const | `number`              | Names the protocol-error status code, 1002.                                                                                                 |
| `WEBSOCKET_CLOSE_UNSUPPORTED`       | const | `number`              | Names the unsupported-data status code, 1003.                                                                                               |
| `WEBSOCKET_CLOSE_INVALID`           | const | `number`              | Names the invalid-frame-payload-data status code, 1007.                                                                                     |
| `WEBSOCKET_CLOSE_TOO_BIG`           | const | `number`              | Names the message-too-big status code, 1009.                                                                                                |
| `WEBSOCKET_MAX_PAYLOAD`             | const | `number`              | Names the default cap on both an inbound frame's declared length and a reassembled message's total byte count, 104,857,600 bytes (100 MiB). |
| `WEBSOCKET_CLOSE_TIMEOUT_MS`        | const | `number`              | Names the default close-handshake timeout, 30,000 milliseconds — how long `close` waits for the peer's echo.                                |
| `WEBSOCKET_CONTROL_MAX_LENGTH`      | const | `number`              | Names the maximum control-frame payload length, 125 bytes.                                                                                  |
| `WEBSOCKET_CLOSE_REASON_MAX_LENGTH` | const | `number`              | Names the maximum UTF-8 close-reason length after the two-byte status code, 123.                                                            |
| `WEBSOCKET_FAIL_TIMEOUT_MS`         | const | `number`              | Names the flush grace, 1,000 milliseconds, a validation-breach close frame is given before the hard teardown fallback destroys the socket.  |

### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| API                      | Kind      | Shape                                                                          | Summary                                                                                                                                                                                          |
| ------------------------ | --------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WebSocketReadyState`    | type      | `0 \| 1 \| 2 \| 3`                                                             | Represents a WebSocket ready state — the stage a connection has reached between the handshake and the socket's end.                                                                              |
| `WebSocketFrame`         | interface | `{ fin, opcode, payload, consumed, masked, rsv }`                              | Represents a parsed RFC 6455 frame — the structured result of decoding one frame off the wire.                                                                                                   |
| `WebSocketEncodeOptions` | interface | `{ masked?, mask? }`                                                           | Represents the options for `encodeWebSocketFrame` — how a frame is masked on the wire.                                                                                                           |
| `WebSocketErrorCode`     | type      | `'OPTION' \| 'LIMIT' \| 'CLOSE' \| 'FRAME'`                                    | Represents the subject a `WebSocketError` names as refused.                                                                                                                                      |
| `NodeWebSocketEventMap`  | type      | `{ open, message, close, error, ping, pong }`                                  | Represents the event map a `NodeWebSocketInterface` emitter carries.                                                                                                                             |
| `NodeWebSocketOptions`   | interface | `{ socket, key?, head?, protocol?, on?, error?, payload?, timeout?, signal? }` | Represents the options for `createNodeWebSocket` — the upgraded `socket`, the `key` that selects server or client mode, and the listeners, caps, and cancellation signal the wrapper runs under. |
| `NodeWebSocketInterface` | interface | `{ emitter, readyState } plus send, ping, close, destroy`                      | Represents the behavioral contract a server-native WebSocket exposes over a raw upgraded socket.                                                                                                 |

Frame payloads are raw `Buffer`s off the wire; a text frame decodes to a `string` at the boundary, and the untyped socket `data` chunk is narrowed to a `Buffer` with a guard, never an assertion.

## Methods

The public methods of the behavioral interface — its `readonly` data members `emitter` and `readyState` stay in the preceding Surface row. `NodeWebSocket` implements `NodeWebSocketInterface` exactly, so this doubles as the per-instance method surface.

#### `NodeWebSocketInterface`

| Method    | Returns | Summary                                                                                                                                                                            |
| --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`    | `void`  | Writes a message as a UTF-8 text frame, masked in client mode and unmasked in server mode, and does nothing unless `readyState` is open.                                           |
| `ping`    | `void`  | Writes a ping frame with an optional payload, which the peer answers with a pong, and does nothing unless `readyState` is open.                                                    |
| `close`   | `void`  | Starts the closing handshake: moves to the closing ready state, writes a close frame carrying the two-byte big-endian `code` and an optional `reason`, and ends the writable side. |
| `destroy` | `void`  | Tears the socket down immediately: detaches the wrapper's domain socket listeners, destroys the socket, emits a final `close`, and tears the emitter down.                         |

## Contract

These invariants hold across `src/server` ↔ `websocket.md`:

1. **DOC ↔ SOURCE bijection.** Every row in the `## Surface` tables is a real export of the module, and every export appears as a Surface row — exhaustive, both directions.
2. **Wire-only, schema-agnostic.** The wrapper speaks the RFC 6455 frame protocol and nothing else — no MCP, no JSON-RPC, no message schema. A higher transport is built _on_ it, keeping this interface minimal.
3. **The codec and boundary guards are pure and exhaustively pinned.** The helpers are tested against RFC 6455's worked vectors, malformed handshake values, non-canonical length encodings, truncation at every byte, and seeded round trips. `parseWebSocketFrame` returns `undefined` on an **incomplete** buffer (the caller accumulates across `data` chunks); `encode` and `parse` are exact inverses for valid frames.
4. **Server vs. client is the single `key` decision.** A canonical 16-byte-base64 `key` (the client's `Sec-WebSocket-Key`) selects server mode: the wrapper writes the `101 Switching Protocols` handshake with `Sec-WebSocket-Accept: computeWebSocketAccept(key)` and sends **unmasked** frames. No `key` is client mode: no handshake is written and every outgoing frame is **masked** — RFC 6455 §5.3 mandates client→server masking. A negotiated `protocol` is accepted only in server mode and must pass `isWebSocketProtocol`; a malformed constructor option throws an `OPTION`-coded `WebSocketError` before the wrapper writes to or assumes ownership of the socket.
5. **One accumulation buffer, drained frame by frame.** Incoming `data` chunks append to a buffer that is decoded with `parseWebSocketFrame` in a loop, slicing each frame's `consumed` bytes off the front and re-parsing until a partial frame remains. Every iteration independently checks canonical encoding and the declared payload cap, including the second and later frames in one chunk. Dispatch by opcode: a data frame (text, binary, or `WEBSOCKET_OPCODE_CONTINUATION`) buffers its fragments and emits one `message` (decoded UTF-8) at `fin`; a ping emits `ping` and is **auto-answered with a pong**; a pong emits `pong`; a close is echoed back (RFC 6455 §5.5.1), ends the socket, and emits the final `close`.
6. **Observable, and a faulty listener can never sink the socket.** The wrapper exposes a typed `emitter` it owns by composition; listener isolation is the emitter's job. The error channels stay distinct: an underlying socket fault emits the map's domain `error` event and terminates the wrapper, whereas a listener that _throws_ is caught by the emitter and routed to its own `error` handler (the `error` constructor option), never re-entered as a domain event. Every terminal path detaches only the wrapper's domain `data` / `close` / `error` listeners and leaves one durable no-op socket `error` sink, so a late peer RST cannot become an uncaught Node exception; caller-owned listeners remain untouched.
7. **A malformed or over-limit peer fails the connection, never the process.** `matchesWebSocketCanonical` rejects non-minimal extended lengths and a set 64-bit high bit with `WEBSOCKET_CLOSE_PROTOCOL`; `measureWebSocketFrame` rejects each frame whose declared length exceeds `payload` (default `WEBSOCKET_MAX_PAYLOAD`) before its bytes are buffered, and the same cap applies to a reassembled fragmented message's total size — either cap breach closes `WEBSOCKET_CLOSE_TOO_BIG`. A text payload that fails `parseUTF8` closes `WEBSOCKET_CLOSE_INVALID`; a received close code that fails `isCloseCode` closes `WEBSOCKET_CLOSE_PROTOCOL`; a fragmented or oversized control frame, nonzero `rsv`, reserved opcode, or wrong mask direction also closes `WEBSOCKET_CLOSE_PROTOCOL`. `close()` uses a configurable timeout so a silent peer cannot leak the handle open. Validation failures flush their close frame before the hard-teardown fallback destroys the socket.
8. **An `AbortSignal` is an external cancellation seam.** `signal` (composing with `@orkestrel/abort` / `@orkestrel/timeout`'s native `AbortSignal`s) tears the socket down through `destroy()` on abort — immediately after construction if already aborted, otherwise on the signal's `abort` event. The listener is removed on every terminal path (`#finish` and `destroy`) so a long-lived, shared signal never accumulates listeners from closed sockets.

## Errors

`WebSocketError` is the one failure type, carrying a stable machine-readable `code`. Narrow a caught value with `isWebSocketError`, then branch on `code`.

| Code     | Raised when                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPTION` | `createNodeWebSocket` refused a `NodeWebSocketOptions` member: `payload`, `timeout`, `key`, `protocol`, or a `protocol` given without a server `key`.                                 |
| `LIMIT`  | An outbound control-frame payload exceeded its RFC 6455 §5.5 cap: a `ping` payload past `WEBSOCKET_CONTROL_MAX_LENGTH`, or a `close` reason past `WEBSOCKET_CLOSE_REASON_MAX_LENGTH`. |
| `CLOSE`  | `close` received a status code `isCloseCode` refuses.                                                                                                                                 |
| `FRAME`  | `encodeWebSocketFrame` refused a frame-header argument: an opcode outside the four-bit wire field, a `mask` that is not 4 bytes, or a `mask` without `masked: true`.                  |

Every refusal is a caller-supplied value the wire protocol cannot carry, and each throws before it writes a byte: an `OPTION` throws before the wrapper writes to or assumes ownership of the socket, a `LIMIT` and a `CLOSE` throw without writing a frame or changing `readyState`, and a `FRAME` throws out of the pure encoder, which touches no socket at all. A **peer's** protocol violation is not a `WebSocketError`: it closes the connection with the matching `WEBSOCKET_CLOSE_*` status code and emits `close`, per the preceding Contract invariant.

`context` carries the refused value under a key naming it — the offending option for an `OPTION`, `size` and the `limit` it exceeded for a `LIMIT`, the refused `code` for a `CLOSE`, and `opcode` or the mask's `size` for a `FRAME`. A `mask` supplied without `masked: true` carries no `context`; the message names the fault.

```ts
import { createNodeWebSocket, isWebSocketError } from '@orkestrel/websocket'

server.on('upgrade', (request, socket, head) => {
	const key = request.headers['sec-websocket-key']
	if (typeof key !== 'string') {
		socket.destroy()
		return
	}
	try {
		createNodeWebSocket({ socket, key, head })
	} catch (error) {
		if (isWebSocketError(error) && error.code === 'OPTION') {
			socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
			socket.destroy()
		}
	}
})
```

## Patterns

### Accept an upgrade and echo messages (server mode)

The handle is fully driven through its `emitter` — attach as many observers as you like; a throw in one is isolated and never reaches the socket.

```ts
import { createNodeWebSocket } from '@orkestrel/websocket'

server.on('upgrade', (request, socket, head) => {
	const key = request.headers['sec-websocket-key']
	if (typeof key !== 'string') {
		socket.destroy()
		return
	}
	const ws = createNodeWebSocket({
		socket,
		key,
		head, // any bytes already buffered after the upgrade headers
		on: { message: (text) => ws.send(`echo: ${text}`) }, // wired before the first frame arrives
	})
	ws.emitter.on('message', (text) => log('echoed', text)) // a second observer of the same event
	ws.emitter.on('close', (code, reason) => log('closed', code, reason))
})
```

### Stream-decode frames across chunk boundaries

Accumulate incoming bytes into one buffer and loop `parseWebSocketFrame` over it, slicing off each complete frame until an incomplete one remains:

```ts
import { parseWebSocketFrame } from '@orkestrel/websocket'

let buffer = Buffer.alloc(0)
socket.on('data', (chunk: Buffer) => {
	buffer = Buffer.concat([buffer, chunk])
	for (;;) {
		const frame = parseWebSocketFrame(buffer)
		if (frame === undefined) break // incomplete — wait for more bytes
		buffer = buffer.subarray(frame.consumed) // slice the frame off, re-parse the rest
		handle(frame)
	}
})
```

### Encode a frame to the wire (server unmasked, client masked)

Encode the same text payload twice, once as a server frame and once as a masked client frame:

```ts
import { encodeWebSocketFrame, WEBSOCKET_OPCODE_TEXT } from '@orkestrel/websocket'

socket.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'hello')) // server→client (unmasked)
socket.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'hello', { masked: true })) // client→server
```

### Compute the handshake accept token

Compute the `Sec-WebSocket-Accept` value RFC 6455 §1.3 works through as its own example:

```ts
import { computeWebSocketAccept } from '@orkestrel/websocket'

computeWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ==') // 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' (RFC 6455 §1.3)
```

### Keep a connection alive, and tear it down on demand

Ping the peer on an interval, clear the timer when the connection closes, and destroy the socket immediately on a fatal error:

```ts
import { createNodeWebSocket } from '@orkestrel/websocket'

const ws = createNodeWebSocket({ socket })
ws.emitter.on('pong', () => console.log('peer is alive'))

const heartbeat = setInterval(() => ws.ping(), 30_000) // liveness probe; answered by an auto-pong
ws.emitter.on('close', () => clearInterval(heartbeat))

// Later, or on a fatal error — abort immediately without a close handshake:
ws.destroy()
```

### Practices

- **Reach for a message transport, not raw frames, when you have a protocol.** This is the wire-level handle a higher-level message transport is built on; drop to it directly only for bespoke framing where no schema applies. If you find yourself hand-rolling request/response correlation on top, you want the layer that sits over this one.
- **Let the mode handle masking — never set the mask bit yourself.** Server mode sends unmasked, client mode masks; the single `key` choice decides it. Reach for `encodeWebSocketFrame(..., { masked: true })` only when you are feeding the parser a synthetic client frame, for example in a test.
- **Drive the parser as a stream, never per-chunk.** Accumulate `data`, loop `parseWebSocketFrame`, slice `consumed` off, and treat `undefined` as "need more bytes". A frame can span chunks and a chunk can hold several frames — the buffer is what reconciles both.
- **Observe everything through the `emitter`.** Wire `message` / `close` / `ping` / `pong` and the domain `error`; a listener that throws is contained by the emitter and surfaced on its own `error` handler (the `error` option), so one bad observer never takes the connection down.

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/server` bijection, the `## Methods` ↔ interface/class method parity, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Accept an upgrade and echo messages (server mode)` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences and asserts the values their comments claim.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) — the RFC 6455 codec helpers and boundary predicates as pure units against the spec's own byte vectors: the §1.3 handshake accept token, the unmasked + masked "Hello" frame encoding (§5.7), the 7/16/64-bit length-form boundaries (125 / 126 / 65 536), `measureWebSocketFrame` reading the declared length off the header alone, `matchesWebSocketCanonical`'s §5.2 minimal-length-encoding check (each shortest form accepted, an incomplete length prefix answered `undefined`, a non-minimal extended length or a set 64-bit high bit rejected), `isWebSocketKey` and `isWebSocketProtocol` against canonical and malformed handshake values, and `isCloseCode` classifying every receivable and rejected close code.
- [`tests/src/server/parsers.test.ts`](../tests/src/server/parsers.test.ts) — the RFC 6455 coercers as pure units: `parseWebSocketFrame` against the spec's own byte vectors (the control opcodes, an incomplete buffer → `undefined` split mid-header/mid-mask/mid-payload, trailing-byte recovery through `consumed`, the encode↔parse inverse), and `parseUTF8` against valid and malformed UTF-8 sequences.
- [`tests/src/server/NodeWebSocket.test.ts`](../tests/src/server/NodeWebSocket.test.ts) — the wrapper driven end to end over an in-memory `node:stream` Duplex pair (a cross-wired `PassThrough` at each end — a real bidirectional socket, no mock): the 101 handshake (with subprotocol echo), a masked client text frame → `message`, continuation-fragment reassembly, two frames in one chunk, `send` → an unmasked readable frame, ping → auto-pong, the close handshake + `close` event, `destroy` idempotency, and observer-error isolation.
- [`tests/integration.test.ts`](../tests/integration.test.ts) — the public factory driven by native `WebSocket` clients against a real Node HTTP upgrade server: handshake, multibyte and 2 MB payloads, binary rejection, client/server closes, ordered bursts, concurrency, churn, and reconnect.

## See also

- [`AGENTS.md`](../AGENTS.md) — the coding rules this package follows.
- [`README.md`](README.md) — the guides index.
