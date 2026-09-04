# WebSocket

> The server-native bidirectional transport: a lean, typed wrapper over a raw upgraded [`node:stream`](https://nodejs.org/api/stream.html) Duplex socket that speaks **only** the [RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455) WebSocket wire protocol — zero npm dependencies (`node:crypto` for the one handshake hash, nothing else). After an HTTP server hands you an upgraded socket, this wrapper turns that raw byte stream into a typed, observable connection: it owns the upgrade handshake, the masked/unmasked frame codec, ping/pong, and the close handshake, and surfaces messages through an owned `emitter`.
>
> What it deliberately is **not**: it has no knowledge of MCP, JSON-RPC, reconnection, heartbeats, or any message schema. Those belong to a _message_ transport built one layer up — this is only the wire. Its codec and boundary guards are pure exported functions, pinned against RFC 6455's worked byte vectors and malformed-input cases; the [`NodeWebSocket`](#nodewebsocketinterface) class is the thin stateful driver that runs them over a socket. Keeping the codec pure and the wrapper minimal is the same lean-native-wrapper discipline: a small typed surface over native power, the hard parts exported as testable units. Source: [`src/server`](../src/server). Surfaced through the `@src/server` barrel.

## Surface

```ts
import { createServer } from 'node:http'
import { createNodeWebSocket } from '@orkestrel/websocket'

// A node:http server hands every upgrade request a raw socket; this wrapper takes it
// from there. Passing the client's `sec-websocket-key` selects SERVER mode — the
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

Narrow the header before the call. `sec-websocket-key` is typed `string | undefined`, and omitting `key` is what selects CLIENT mode: the wrapper writes no 101 handshake and masks its frames, so a browser waiting for the handshake sees a connection that never opens. The guard turns a missing header into a refused socket instead.

### Factories

| API                   | Kind     | Summary                                                                                                                   |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `createNodeWebSocket` | function | A server-native WebSocket over a raw upgraded `node:stream` Duplex — server mode when a `key` is given, else client mode. |

### Entities

| API             | Kind  | Summary                                                                                                                   |
| --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `NodeWebSocket` | class | The WebSocket — the handshake, frame dispatch (text + continuation reassembly), auto-pong, close, and an owned `emitter`. |

### Errors

| API                | Kind     | Summary                                                                                             |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| `WebSocketError`   | class    | A refused caller-supplied value, carrying a machine-readable `code` and an optional `context`.      |
| `isWebSocketError` | function | Whether a caught value is a `WebSocketError`, narrowing it so a `catch` can branch on `error.code`. |

### Codec helpers

| API                         | Kind     | Summary                                                                                                                                   |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `computeWebSocketAccept`    | function | The `Sec-WebSocket-Accept` token, the base64 SHA-1 of the key plus `WEBSOCKET_GUID`.                                                      |
| `isWebSocketKey`            | function | Whether a value is the canonical base64 encoding of a 16-byte `Sec-WebSocket-Key`.                                                        |
| `isWebSocketProtocol`       | function | Whether a value is one valid HTTP-token WebSocket subprotocol (no separators or header injection).                                        |
| `parseWebSocketFrame`       | function | One frame decoded off a buffer; `undefined` when the buffer is incomplete, so the caller accumulates.                                     |
| `measureWebSocketFrame`     | function | A frame's declared payload length off the buffer without buffering the payload; `undefined` until the length field itself is complete.    |
| `matchesWebSocketCanonical` | function | Whether the next frame uses the shortest valid length encoding; `undefined` until its length prefix is complete.                          |
| `parseUTF8`                 | function | The bytes decoded as strict UTF-8; `undefined` when the sequence is malformed.                                                            |
| `isCloseCode`               | function | Whether a numeric value is a valid RFC 6455 close status code to receive (extended with the IANA-registered `1012`–`1014` interop codes). |
| `encodeWebSocketFrame`      | function | One frame as wire bytes, the inverse of `parseWebSocketFrame`; unmasked by default, optionally masked.                                    |

### Constants

| API                                 | Kind  | Summary                                                                                                      |
| ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `WEBSOCKET_GUID`                    | const | The RFC 6455 §1.3 accept GUID concatenated to the key before the hash.                                       |
| `WEBSOCKET_VERSION`                 | const | The supported protocol version (`'13'`).                                                                     |
| `WEBSOCKET_OPCODE_TEXT`             | const | Text frame opcode (`0x01`).                                                                                  |
| `WEBSOCKET_OPCODE_BINARY`           | const | Binary frame opcode (`0x02`).                                                                                |
| `WEBSOCKET_OPCODE_CONTINUATION`     | const | Continuation frame opcode (`0x00`).                                                                          |
| `WEBSOCKET_OPCODE_CLOSE`            | const | Close frame opcode (`0x08`).                                                                                 |
| `WEBSOCKET_OPCODE_PING`             | const | Ping frame opcode (`0x09`).                                                                                  |
| `WEBSOCKET_OPCODE_PONG`             | const | Pong frame opcode (`0x0a`).                                                                                  |
| `WEBSOCKET_READY_CONNECTING`        | const | Ready state `0` (connecting).                                                                                |
| `WEBSOCKET_READY_OPEN`              | const | Ready state `1` (open).                                                                                      |
| `WEBSOCKET_READY_CLOSING`           | const | Ready state `2` (closing).                                                                                   |
| `WEBSOCKET_READY_CLOSED`            | const | Ready state `3` (closed).                                                                                    |
| `WEBSOCKET_CLOSE_NORMAL`            | const | The normal-closure status code (`1000`) — the default `close` code.                                          |
| `WEBSOCKET_CLOSE_PROTOCOL`          | const | Protocol-error status code (`1002`) — a framing/state rule was violated.                                     |
| `WEBSOCKET_CLOSE_UNSUPPORTED`       | const | Unsupported-data status code (`1003`) — the endpoint received a data type it cannot accept.                  |
| `WEBSOCKET_CLOSE_INVALID`           | const | Invalid-frame-payload-data status code (`1007`) — for example non-UTF-8 text or an unparseable close reason. |
| `WEBSOCKET_CLOSE_TOO_BIG`           | const | Message-too-big status code (`1009`) — a reassembled message exceeded the payload cap.                       |
| `WEBSOCKET_MAX_PAYLOAD`             | const | The default maximum inbound single-frame length AND reassembled-message total byte count (100 MiB).          |
| `WEBSOCKET_CLOSE_TIMEOUT_MS`        | const | The default close-handshake timeout in milliseconds — how long `close()` waits for the peer's echo.          |
| `WEBSOCKET_CONTROL_MAX_LENGTH`      | const | The maximum control-frame payload length in bytes (RFC 6455 §5.5).                                           |
| `WEBSOCKET_CLOSE_REASON_MAX_LENGTH` | const | The maximum UTF-8 close-reason length after its two-byte status code (`123`).                                |
| `WEBSOCKET_FAIL_TIMEOUT_MS`         | const | The post-`#fail` flush grace in milliseconds before the hard-teardown fallback destroys the socket.          |

### Types

| API                      | Kind      | Summary                                                                                                                         |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `WebSocketReadyState`    | type      | The four browser-compatible ready-state values (`0` \| `1` \| `2` \| `3`).                                                      |
| `WebSocketFrame`         | interface | A parsed frame — `fin` / `opcode` / `payload` / `consumed` / `masked` / `rsv`.                                                  |
| `WebSocketEncodeOptions` | interface | `encodeWebSocketFrame` masking control — `masked` and an optional explicit `mask`.                                              |
| `WebSocketErrorCode`     | type      | The subject a `WebSocketError` names as refused — `OPTION` / `LIMIT` / `CLOSE` / `FRAME`.                                       |
| `NodeWebSocketEventMap`  | type      | The event map — `open` / `message` / `close` / `error` / `ping` / `pong`.                                                       |
| `NodeWebSocketOptions`   | interface | Options for `createNodeWebSocket` (`socket` / `key` / `head` / `protocol` / `on` / `error` / `payload` / `timeout` / `signal`). |
| `NodeWebSocketInterface` | interface | The wrapper contract — the `emitter` and `readyState` data members plus `send` / `ping` / `close` / `destroy`.                  |

Frame payloads are raw `Buffer`s off the wire; a text frame decodes to a `string` at the boundary, and the untyped socket `data` chunk is narrowed to a `Buffer` with a guard, never an assertion.

## Methods

The public methods of the behavioral interface — its `readonly` data members `emitter` and `readyState` stay in the preceding Surface row. `NodeWebSocket` implements `NodeWebSocketInterface` exactly, so this doubles as the per-instance method surface.

#### `NodeWebSocketInterface`

| Method    | Returns | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`    | `void`  | Frame `message` as a UTF-8 text frame and write it (masked in client mode, unmasked in server mode). No-op unless `readyState` is open.                                                                                                                                                                                                                                                                                                                                               |
| `ping`    | `void`  | Write a ping frame with an optional payload; the peer is expected to answer with a pong (surfaced as `pong`). No-op unless open; throws a `LIMIT`-coded `WebSocketError` when the UTF-8 payload exceeds `WEBSOCKET_CONTROL_MAX_LENGTH`.                                                                                                                                                                                                                                               |
| `close`   | `void`  | Start the closing handshake: move to `closing`, write a close frame (the 2-byte big-endian `code` — default `WEBSOCKET_CLOSE_NORMAL` — plus optional `reason`), and end the writable side. An invalid or fractional code throws a `CLOSE`-coded `WebSocketError` and a reason over `WEBSOCKET_CLOSE_REASON_MAX_LENGTH` a `LIMIT`-coded one, in each case without changing state. The final `close` event fires after the peer echoes or the socket ends. A second `close` is a no-op. |
| `destroy` | `void`  | Abort immediately: detach the wrapper's domain socket listeners, destroy the socket, emit a final `close`, and tear the emitter down. Idempotent — a hard stop, not a handshake.                                                                                                                                                                                                                                                                                                      |

## Contract

These invariants hold across `src/server` ↔ `websocket.md`:

1. **DOC ↔ SOURCE bijection.** Every row in the `## Surface` tables is a real export of the module, and every export appears as a Surface row — exhaustive, both directions.
2. **Wire-only, schema-agnostic.** The wrapper speaks the RFC 6455 frame protocol and nothing else — no MCP, no JSON-RPC, no message schema. A higher transport is built _on_ it, keeping this interface minimal.
3. **The codec and boundary guards are pure and exhaustively pinned.** The helpers are tested against RFC 6455's worked vectors, malformed handshake values, non-canonical length encodings, truncation at every byte, and seeded round trips. `parseWebSocketFrame` returns `undefined` on an **incomplete** buffer (the caller accumulates across `data` chunks); `encode` and `parse` are exact inverses for valid frames.
4. **Server vs. client is the single `key` decision.** A canonical 16-byte-base64 `key` (the client's `Sec-WebSocket-Key`) selects SERVER mode: the wrapper writes the `101 Switching Protocols` handshake with `Sec-WebSocket-Accept: computeWebSocketAccept(key)` and sends **unmasked** frames. No `key` is CLIENT mode: no handshake is written and every outgoing frame is **masked** — RFC 6455 §5.3 mandates client→server masking. A negotiated `protocol` is accepted only in server mode and must pass `isWebSocketProtocol`; a malformed constructor option throws an `OPTION`-coded `WebSocketError` before the wrapper writes to or assumes ownership of the socket.
5. **One accumulation buffer, drained frame by frame.** Incoming `data` chunks append to a buffer that is decoded with `parseWebSocketFrame` in a loop, slicing each frame's `consumed` bytes off the front and re-parsing until a partial frame remains. Every iteration independently checks canonical encoding and the declared payload cap, including the second and later frames in one chunk. Dispatch by opcode: a data frame (text, binary, or `WEBSOCKET_OPCODE_CONTINUATION`) buffers its fragments and emits one `message` (decoded UTF-8) at `fin`; a ping emits `ping` and is **auto-answered with a pong**; a pong emits `pong`; a close is echoed back (RFC 6455 §5.5.1), ends the socket, and emits the final `close`.
6. **Observable, and a faulty listener can never sink the socket.** The wrapper exposes a typed `emitter` it owns by composition; listener isolation is the emitter's job. Two error channels stay distinct: an underlying socket fault emits the map's domain `error` event and terminates the wrapper, whereas a listener that _throws_ is caught by the emitter and routed to its own `error` handler (the `error` constructor option), never re-entered as a domain event. Every terminal path detaches only the wrapper's domain `data` / `close` / `error` listeners and leaves one durable no-op socket `error` sink, so a late peer RST cannot become an uncaught Node exception; caller-owned listeners remain untouched.
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
	})
	ws.emitter.on('message', (text) => ws.send(`echo: ${text}`))
	ws.emitter.on('close', (code, reason) => log('closed', code, reason))
})
```

### Stream-decode frames across chunk boundaries

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

```ts
import { encodeWebSocketFrame, WEBSOCKET_OPCODE_TEXT } from '@orkestrel/websocket'

socket.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'hello')) // server→client (unmasked)
socket.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'hello', { masked: true })) // client→server
```

### Compute the handshake accept token

```ts
import { computeWebSocketAccept } from '@orkestrel/websocket'

computeWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ==') // 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' (RFC 6455 §1.3)
```

### Keep a connection alive, and tear it down on demand

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

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/server` bijection, the `## Methods` ↔ interface/class method parity, and the flagship fences transcribed and asserted on the values their comments claim.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) — the RFC 6455 codec helpers and boundary predicates as pure units against the spec's own byte vectors: the §1.3 handshake accept token, the unmasked + masked "Hello" frame encoding (§5.7), the 7/16/64-bit length-form boundaries (125 / 126 / 65 536), `measureWebSocketFrame` reading the declared length off the header alone, `matchesWebSocketCanonical`'s §5.2 minimal-length-encoding check (each shortest form accepted, an incomplete length prefix answered `undefined`, a non-minimal extended length or a set 64-bit high bit rejected), `isWebSocketKey` and `isWebSocketProtocol` against canonical and malformed handshake values, and `isCloseCode` classifying every receivable and rejected close code.
- [`tests/src/server/parsers.test.ts`](../tests/src/server/parsers.test.ts) — the RFC 6455 coercers as pure units: `parseWebSocketFrame` against the spec's own byte vectors (the control opcodes, an incomplete buffer → `undefined` split mid-header/mid-mask/mid-payload, trailing-byte recovery through `consumed`, the encode↔parse inverse), and `parseUTF8` against valid and malformed UTF-8 sequences.
- [`tests/src/server/NodeWebSocket.test.ts`](../tests/src/server/NodeWebSocket.test.ts) — the wrapper driven end to end over an in-memory `node:stream` Duplex pair (two cross-wired `PassThrough`s — a real bidirectional socket, no mock): the 101 handshake (with subprotocol echo), a masked client text frame → `message`, continuation-fragment reassembly, two frames in one chunk, `send` → an unmasked readable frame, ping → auto-pong, the close handshake + `close` event, `destroy` idempotency, and observer-error isolation.
- [`tests/integration.test.ts`](../tests/integration.test.ts) — the public factory driven by native `WebSocket` clients against a real Node HTTP upgrade server: handshake, multibyte and 2 MB payloads, binary rejection, client/server closes, ordered bursts, concurrency, churn, and reconnect.

## See also

- [`AGENTS.md`](../AGENTS.md) — the coding rules this package follows.
- [`README.md`](README.md) — the guides index.
