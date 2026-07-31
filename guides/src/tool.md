# Tool

> **The tool runtime for the `@orkestrel` line.** A tool is a callable function described by a
> JSON Schema — a `name`, an optional description, an optional parameter schema, and the handler
> that runs it. That is the whole idea: a tool is an API call whose shape is data, so whoever
> calls it can discover it, present it, and invoke it without knowing anything about the code
> behind it. `Tool` binds the advertised definition to its handler; `ToolManager` keeps tools by
> name in insertion order, advertises their definitions, and executes calls with per-call error
> isolation; `ToolCall` and `ToolResult` are the correlated pair that travels between a caller
> and the registry. Source: [`src/core`](../../src/core). Published through `@orkestrel/tool`.
>
> **Anyone can call a tool.** Nothing here is model-specific — `tools.execute(call)` is an
> ordinary async call returning an ordinary result, and plain application code may drive it
> directly. The shape exists because callers that work from descriptions need the description
> and the handler to travel together: an agent loop choosing which function to invoke, an MCP
> bridge exposing local capability to a remote client, a backend dispatching a named operation.
> `@orkestrel/agent` and `@orkestrel/mcp` are two such callers; ready-made tools ship in
> `@orkestrel/toolbox`.
>
> **Mechanism only.** This runtime advertises, dispatches, and contains failure. It transports
> nothing, validates no arguments against a tool's schema, authorizes no call, and ships no
> concrete tools. Each of those is a decision that belongs to the caller, to a policy layer, or
> to the tool itself.

Two nouns carry the runtime. A `Tool` is inert — a definition plus a handler, with no lifecycle
and no failure handling of its own. A `ToolManager` is the live surface a caller holds: it hands
`definitions()` outward, takes a `ToolCall` back, and answers with a `ToolResult` that is always
a result and never a throw. Everything else in this module is the plain data those two exchange.

## Surface

### Contracts

The data shapes, from [`types.ts`](../../src/core/types.ts). Every property is readonly, and an
absent optional field is simply absent.

| Name                   | Kind      | Shape / Purpose                                                                                                                   |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ToolDefinition`       | interface | `{ name, description?, parameters? }` — what a caller advertises: the selectable name and the open JSON Schema for its arguments. |
| `ToolCall`             | interface | `{ id, name, arguments }` — one request to run a named tool, `id` correlating it with its later result.                           |
| `ToolResult`           | interface | `{ id, name, value?, error? }` — the correlated outcome: `value` on success, `error` on failure, never both.                      |
| `ToolOptions`          | interface | `{ name, description?, summary?, parameters?, execute }` — the construction input for an executable tool.                         |
| `ToolInterface`        | interface | A `ToolDefinition` plus an optional `summary` and the handler that runs it. See [`## Methods`](#methods).                         |
| `ToolManagerInterface` | interface | The registry contract; its readonly `count` is the number of registered tools. See [`## Methods`](#methods).                      |

### Helpers

The call-envelope guard, from [`helpers.ts`](../../src/core/helpers.ts).

| Name         | Kind     | Signature                               | Behavior                                                                                                                                                              |
| ------------ | -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isToolCall` | function | `(value: unknown) => value is ToolCall` | Total guard for the envelope: a plain record with string `id` and `name` and a plain-record `arguments`. Malformed or hostile input returns `false`; it never throws. |

### Factories

From [`factories.ts`](../../src/core/factories.ts) — the constructor-free way to reach both
classes.

| Name                | Kind     | Signature                                 | Behavior                                                                  |
| ------------------- | -------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| `createTool`        | function | `(options: ToolOptions) => ToolInterface` | Creates an executable tool bound to the supplied handler.                 |
| `createToolManager` | function | `() => ToolManagerInterface`              | Creates an empty registry that advertises definitions and executes calls. |

### `Tool`

The implementing class of `ToolInterface`, from [`Tool.ts`](../../src/core/tools/Tool.ts). It
copies the fields it was given — omitting each optional one that was not supplied — and keeps
the handler in a private field, so a tool's advertised shape cannot drift from what it executes.
The parameter schema and the argument record are forwarded by reference, never cloned. `Tool`
deliberately does not catch: a handler that throws throws, and per-call isolation belongs to the
registry that dispatched it. See [`## Methods`](#methods) for its public call surface.

### `ToolManager`

The implementing class of `ToolManagerInterface`, from
[`ToolManager.ts`](../../src/core/tools/ToolManager.ts). One name-keyed map is its whole state:
tools stay in insertion order, `tools()` and `definitions()` return fresh readonly arrays rather
than a view of that map, and every projection is computed on demand so a mutation can never
leave a stale copy behind. It is the only place a call can fail into a result instead of an
exception. See [`## Methods`](#methods) for its public call surface.

## Methods

The public call-signature members of each behavioral interface, one table per interface.

#### `ToolInterface`

| Method    | Returns                       | Behavior                                                                                         |
| --------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `execute` | `Promise<unknown> \| unknown` | Runs the handler against the supplied arguments record and returns whatever the handler returns. |

#### `ToolManagerInterface`

| Method        | Returns                                        | Behavior                                                                                    |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `add`         | `void`                                         | Registers one tool or a readonly batch; a repeated name overwrites in place.                |
| `tool`        | `ToolInterface \| undefined`                   | Finds one registered tool by name, returning the exact registered instance.                 |
| `tools`       | `readonly ToolInterface[]`                     | Lists the registered tools in insertion order.                                              |
| `definitions` | `readonly ToolDefinition[]`                    | Lists the advertised definitions, preferring each tool's summary over its full description. |
| `execute`     | `Promise<ToolResult \| readonly ToolResult[]>` | Executes one call or a readonly batch with per-call error isolation.                        |
| `remove`      | `boolean`                                      | Removes one name or a readonly batch of names and reports whether any tool was present.     |
| `clear`       | `void`                                         | Removes every registered tool.                                                              |

## Anatomy of a tool

A definition is the part a caller can read; the handler is the part it cannot. Declare both at
once:

```ts
import { createTool } from '@orkestrel/tool'

const add = createTool({
	name: 'add',
	description: 'Add two numeric values and return their sum. Both operands are required.',
	summary: 'Add two numbers.',
	parameters: {
		type: 'object',
		properties: {
			left: { type: 'number' },
			right: { type: 'number' },
		},
		required: ['left', 'right'],
	},
	execute: (args) => Number(args.left) + Number(args.right),
})
```

`new Tool({ … })` builds the same thing; `createTool` is the form to reach for when a call site
should not name a class.

The schema is descriptive runtime data, forwarded by reference and never interpreted here. A
handler always receives the open `Readonly<Record<string, unknown>>` the caller sent and narrows
the fields it consumes — declaring `required` tells the caller what to send, not this runtime
what to reject. Handlers may be synchronous or asynchronous; the registry awaits either.

`summary` is the short form advertised in place of `description`. Write the full description for
a human reading the source and the summary for a caller paying by the token: the long text stays
on the registered tool, reachable through `tools.tool('add')?.description` whenever something
wants the detail.

## The registry

A registry is a working set, not a global. Build one per caller, fill it with the tools that
caller is allowed to reach, and hand out its definitions:

```ts
import { Tool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add(add) // the tool defined above
tools.add([
	new Tool({ name: 'echo', execute: (args) => args.value }),
	new Tool({ name: 'now', description: 'Current epoch milliseconds.', execute: () => Date.now() }),
])

tools.count // 3
tools.tool('add') // the exact instance that was registered, or undefined
tools.tools() // a fresh readonly array, in insertion order
tools.definitions() // the same order, projected to plain ToolDefinition values

tools.remove('echo') // true — the tool was present
tools.remove(['now', 'ghost']) // true — any one removal counts
tools.clear() // back to empty
```

Order is insertion order, and adding a name that already exists replaces the stored tool without
moving it — the sequence a caller sees stays stable while a tool behind a name is swapped.
Remove a name and add it again and it lands at the end, because the name is genuinely new to the
map. In a batch, later entries win over earlier ones with the same name.

`definitions()` projects fresh plain objects on every call: `name`, then `description` only when
a summary or description exists, then `parameters` only when a schema exists, with the schema
object's original identity preserved. Nothing that arrives on a definition is a live handle on
the registry — advertising cannot be used to reach the handlers.

## Calls and results

A call arrives as unstructured input from somewhere else, so check the envelope before trusting
it, then execute:

```ts
import { isToolCall } from '@orkestrel/tool'

const incoming: unknown = { id: 'call-1', name: 'add', arguments: { left: 2, right: 3 } }

if (isToolCall(incoming)) {
	const result = await tools.execute(incoming)
	result.value // 5 — or result.error, when the call failed
}

const batch = await tools.execute([
	{ id: '1', name: 'add', arguments: { left: 2, right: 3 } }, // → { id: '1', name: 'add', value: 5 }
	{ id: '2', name: 'ghost', arguments: {} }, // → { id: '2', name: 'ghost', error: 'tool not found: ghost' }
])
```

`isToolCall` validates the envelope only: the `id`, the `name`, and that `arguments` is a plain
record. It never checks arguments against a tool's schema, so a well-formed call for a badly
shaped payload still reaches the handler, which is exactly where the domain knowledge to reject
it lives.

Execution always resolves. An unknown name becomes `tool not found: <name>`; a synchronous throw
and an asynchronous rejection are both contained; an `Error` contributes its `message` and any
other thrown value is converted with `String`. Success and failure never mix in one result: a
successful call carries `value` even when that value is `undefined`, `null`, `0`, `''`, or
`false`, and a failed call carries `error` with no `value` key at all. Distinguish the two by
which key is present, not by whether `value` is truthy.

A batch is dispatched concurrently and answered in input order, with each call isolated from its
siblings — one failure never voids the batch, and duplicate ids stay distinct positional calls
rather than collapsing into one. That guarantee is what lets a caller feed every result back to
whatever produced the calls and let it react to the failures itself.

## Callers

The registry's two-sided shape — `definitions()` out, `execute()` back — is all a caller needs,
and it is the same shape whatever sits on the other side.

An agent loop advertises `definitions()` to a model, receives tool calls in the model's reply,
runs them through `execute`, and appends each `ToolResult` to the conversation; because a failure
comes back as an error result, the model sees what went wrong and can try something else instead
of the run collapsing. An MCP bridge maps the same definitions onto the protocol's tool listing
and routes each invocation to `execute`. Plain code skips the discovery half entirely and calls
`execute` with a call it wrote itself — a scheduled job, an HTTP handler dispatching a named
operation, a test.

Concrete tools are not this package's business. `@orkestrel/toolbox` ships ready-made ones, and
anything a `ToolInterface` can describe — a local computation, a database query, a remote API —
registers here unchanged.

## Tests

- [`Tool.test.ts`](../../tests/src/core/tools/Tool.test.ts) — definition binding, optional-field omission, argument identity, return values, and the deliberate absence of handler isolation.
- [`ToolManager.test.ts`](../../tests/src/core/tools/ToolManager.test.ts) — insertion order, overwrite and removal lifecycle, definition projection, and isolated single and batch execution.
- [`factories.test.ts`](../../tests/src/core/factories.test.ts) — factory construction and working instances.
- [`helpers.test.ts`](../../tests/src/core/helpers.test.ts) — tool-call envelope boundaries: incomplete calls, wrong field types, and non-record arguments.

## See also

- [`README.md`](../README.md) — the guides index.
- [`contract.md`](contract.md) — the dependency mirror for `@orkestrel/contract`, whose total guards back `isToolCall` and the registry's overload narrowing.
- [`AGENTS.md`](../../AGENTS.md) — the repository's coding and documentation contract.
