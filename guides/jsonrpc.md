# JSON-RPC 2.0

> The JSON-RPC 2.0 wire contract the Orkestrel protocol packages share: the message types, total
> structural guards that place every parsed JSON value in at most one message arm, the reserved
> error codes, and the response builders.

Source: [`src/core`](../src/core). Published through `@orkestrel/jsonrpc`.

## Messages

A JSON-RPC 2.0 message is an invocation or a response. An invocation is a `JSONRPCRequest`, which
carries an `id` and requires a response, or a `JSONRPCNotification`, which carries no `id` member
and permits none. A response is a `JSONRPCResultResponse`, which echoes the request's `id` beside a
`result`, or a `JSONRPCErrorResponse`, which carries a `JSONRPCError` under `error`.
`JSONRPCInvocation`, `JSONRPCResponse`, and `JSONRPCMessage` name the unions.

A `JSONRPCId` is a string or a finite integer, and never `null`. An error response always carries an
`id` member, and the member holds `null` when the request's id could not be read. A request and a
result response always carry an id.

The package carries parameters by name only: a present `params` member is a record, and the guards
refuse a by-position array.

The guards partition every value whose presence checks and member reads agree. An invocation guard
refuses a value carrying a `result` or `error` member, a response guard refuses a value carrying a
`method` member, the notification guard refuses any `id` member, the result-response guard refuses
an `error` member, and the error-response guard refuses a `result` member. A value carrying both an
invocation's and a response's members is no message. A `Proxy` whose `has` and `get` traps
disagree can satisfy several arms: a `has` trap that denies every member lets one value pass as a
notification and as an error response.

### Classify a message

Pass any parsed value to a guard. Each guard answers for one arm, and `isJSONRPCMessage` answers
for all of them:

```ts
import { isJSONRPCInvocation, isJSONRPCMessage, isJSONRPCResponse } from '@orkestrel/jsonrpc'

const hybrid: unknown = JSON.parse('{"jsonrpc":"2.0","id":1,"method":"ping","result":null}')

isJSONRPCMessage(hybrid) // false
isJSONRPCInvocation({ jsonrpc: '2.0', method: 'initialized' }) // true
isJSONRPCResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) // true
```

## Responses

`buildJSONRPCResult` echoes a request's id beside a result. The id must be an integer or a string
and the result a JSON value, and the builder checks neither. `buildJSONRPCError` writes the
id it is given, `null` included, and omits `data` from the error object when the argument is
absent. The five `JSONRPC_*` constants are the codes JSON-RPC 2.0 reserves for a parse failure, an
invalid request, an unknown method, invalid parameters, and an internal failure. The package throws
no error of its own.

### Answer a request

Parse the payload, answer an unreadable or invalid request with `id: null`, and echo the id of every
request the guard accepts:

```ts
import type { JSONRPCResponse } from '@orkestrel/jsonrpc'
import {
	buildJSONRPCError,
	buildJSONRPCResult,
	isJSONRPCRequest,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
} from '@orkestrel/jsonrpc'

function answer(text: string): JSONRPCResponse {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return buildJSONRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error')
	}
	if (!isJSONRPCRequest(value)) {
		return buildJSONRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request')
	}
	if (value.method !== 'ping') {
		return buildJSONRPCError(value.id, JSONRPC_METHOD_NOT_FOUND, 'Method not found')
	}
	return buildJSONRPCResult(value.id, 'pong')
}

answer('{') // { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
answer('{"jsonrpc":"2.0","id":7,"method":"ping"}') // { jsonrpc: '2.0', id: 7, result: 'pong' }
```

## Validation

Every guard takes `unknown` and never throws. `isJSONRPCId` accepts a string or a finite integer,
and every other guard returns `false` for a value that is not a plain record. A guard reads members
through property access, so an accessor or a `Proxy` with no traps passes when the members it
yields pass. A member that throws on read fails the value, except a `data` member and a member the
contract does not name: no guard reads either, so a throwing accessor there passes. A guard accepts
members the contract does not name.

- `isJSONRPCId` accepts a string, the empty string included, and a finite integer.
- `isJSONRPCError` requires an integer `code` and a string `message`, and accepts any `data`.
- `isJSONRPCRequest` requires `jsonrpc: '2.0'`, an id, and a string `method`.
- `isJSONRPCNotification` requires `jsonrpc: '2.0'` and a string `method`, and refuses an `id`
  member whatever it holds, `undefined` and `null` included.
- `isJSONRPCResultResponse` requires `jsonrpc: '2.0'`, an id, and a `result` member holding any
  value but `undefined`, which JSON cannot carry.
- `isJSONRPCErrorResponse` requires `jsonrpc: '2.0'`, an `id` member holding an id or `null`, and
  an `error` that `isJSONRPCError` accepts.
- `isJSONRPCInvocation`, `isJSONRPCResponse`, and `isJSONRPCMessage` accept what their arms accept.

The following calls show each boundary:

```ts
import {
	isJSONRPCError,
	isJSONRPCErrorResponse,
	isJSONRPCId,
	isJSONRPCNotification,
	isJSONRPCResultResponse,
} from '@orkestrel/jsonrpc'

isJSONRPCId(1.5) // false
isJSONRPCError({ code: -32601, message: 'Method not found', data: { method: 'ping' } }) // true
isJSONRPCNotification({ jsonrpc: '2.0', method: 'log', id: undefined }) // false
isJSONRPCResultResponse({ jsonrpc: '2.0', id: 1, result: null }) // true
isJSONRPCErrorResponse({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }) // false
```

## Surface

### Message types

The package provides these message contracts.

| Name                    | Kind      | Signature                                       | Summary                                                                                                    |
| ----------------------- | --------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `JSONRPCId`             | type      | `string \| number`                              | Identifies a JSON-RPC 2.0 request and the response that answers it.                                        |
| `JSONRPCRequest`        | interface | `{ jsonrpc, id, method, params? }`              | Describes a JSON-RPC 2.0 method call that requires a response.                                             |
| `JSONRPCNotification`   | interface | `{ jsonrpc, method, id?, params? }`             | Describes a JSON-RPC 2.0 method call that permits no response.                                             |
| `JSONRPCInvocation`     | type      | `JSONRPCRequest \| JSONRPCNotification`         | Describes one inbound JSON-RPC 2.0 call, a request or a notification.                                      |
| `JSONRPCError`          | interface | `{ code, message, data? }`                      | Describes the error object a JSON-RPC 2.0 error response carries.                                          |
| `JSONRPCResultResponse` | interface | `{ jsonrpc, id, result, error? }`               | Describes a successful JSON-RPC 2.0 response.                                                              |
| `JSONRPCErrorResponse`  | interface | `{ jsonrpc, id, error, result? }`               | Describes a failed JSON-RPC 2.0 response, with `id` set to `null` when the request's id could not be read. |
| `JSONRPCResponse`       | type      | `JSONRPCResultResponse \| JSONRPCErrorResponse` | Describes either outcome of a JSON-RPC 2.0 request.                                                        |
| `JSONRPCMessage`        | type      | `JSONRPCInvocation \| JSONRPCResponse`          | Describes one complete JSON-RPC 2.0 wire message.                                                          |

### Error codes

The package provides these reserved error codes.

| Name                       | Kind  | Signature | Summary                                                                  |
| -------------------------- | ----- | --------- | ------------------------------------------------------------------------ |
| `JSONRPC_PARSE_ERROR`      | const | `-32700`  | Identifies a payload that is not valid JSON, `-32700`.                   |
| `JSONRPC_INVALID_REQUEST`  | const | `-32600`  | Identifies a payload that is not a valid JSON-RPC 2.0 request, `-32600`. |
| `JSONRPC_METHOD_NOT_FOUND` | const | `-32601`  | Identifies a method the receiver does not provide, `-32601`.             |
| `JSONRPC_INVALID_PARAMS`   | const | `-32602`  | Identifies invalid method parameters, `-32602`.                          |
| `JSONRPC_INTERNAL_ERROR`   | const | `-32603`  | Identifies an internal receiver failure, `-32603`.                       |

### Guards

The package provides these guards.

| Name                      | Kind     | Signature                                            | Summary                                                                    |
| ------------------------- | -------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `isJSONRPCId`             | function | `(value: unknown) => value is JSONRPCId`             | Checks whether a value is a JSON-RPC 2.0 id, a string or a finite integer. |
| `isJSONRPCError`          | function | `(value: unknown) => value is JSONRPCError`          | Checks whether a value is a JSON-RPC 2.0 error object.                     |
| `isJSONRPCRequest`        | function | `(value: unknown) => value is JSONRPCRequest`        | Checks whether a value is a JSON-RPC 2.0 request.                          |
| `isJSONRPCNotification`   | function | `(value: unknown) => value is JSONRPCNotification`   | Checks whether a value is a JSON-RPC 2.0 notification.                     |
| `isJSONRPCInvocation`     | function | `(value: unknown) => value is JSONRPCInvocation`     | Checks whether a value is a JSON-RPC 2.0 request or notification.          |
| `isJSONRPCResultResponse` | function | `(value: unknown) => value is JSONRPCResultResponse` | Checks whether a value is a successful JSON-RPC 2.0 response.              |
| `isJSONRPCErrorResponse`  | function | `(value: unknown) => value is JSONRPCErrorResponse`  | Checks whether a value is a failed JSON-RPC 2.0 response.                  |
| `isJSONRPCResponse`       | function | `(value: unknown) => value is JSONRPCResponse`       | Checks whether a value is a JSON-RPC 2.0 response.                         |
| `isJSONRPCMessage`        | function | `(value: unknown) => value is JSONRPCMessage`        | Checks whether a value is a JSON-RPC 2.0 message.                          |

### Builders

The package provides these response builders.

| Name                 | Kind     | Signature                                                                                        | Summary                                                                   |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `buildJSONRPCResult` | function | `(id: JSONRPCId, result: unknown) => JSONRPCResultResponse`                                      | Builds a successful JSON-RPC 2.0 response that echoes the request's id.   |
| `buildJSONRPCError`  | function | `(id: JSONRPCId \| null, code: number, message: string, data?: unknown) => JSONRPCErrorResponse` | Builds a failed JSON-RPC 2.0 response, omitting `data` when it is absent. |

## Tests

[`tests/src/core`](../tests/src/core) proves the guards, the builders, and the barrel.
