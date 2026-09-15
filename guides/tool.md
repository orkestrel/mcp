# Tool

> The tool runtime for the `@orkestrel` line: a `Tool` binding an advertised JSON Schema
> definition to its handler, a `ToolManager` registry that advertises those definitions and
> executes calls with per-call error isolation, and the correlated `ToolCall` and `ToolResult`
> pair that travels between a caller and the registry.

A tool is a callable function described by a JSON Schema — a `name`, an optional description, an
optional parameter schema, and the handler that runs it. That is the whole idea: a tool is an API
call whose shape is data, so whoever calls it can discover it, present it, and invoke it without
knowing anything about the code behind it.

`Tool` and `ToolManager` carry the runtime. A `Tool` is inert — a definition plus a handler, with
no lifecycle. A configured contract validates arguments before its handler runs. A `ToolManager`
is the live surface a caller holds: it hands `definitions()` outward, takes a `ToolCall` back, and
answers with a `ToolResult`, a result rather than a throw for a call whose members are plain
values. Tools stay in the map by name in insertion order. Everything else in this module is the
plain data those two exchange.

**Anyone can call a tool.** Nothing here is model-specific — `tools.execute(call)` is an ordinary
async call returning an ordinary result, and plain application code may drive it directly. The
shape exists because callers that work from descriptions need the description and the handler to
travel together: an agent loop choosing which function to invoke, an MCP bridge exposing local
capability to a remote client, a backend dispatching a named operation. `@orkestrel/agent` and
`@orkestrel/mcp` are two such callers; ready-made tools ship in `@orkestrel/toolbox`.

**Mechanism only.** This runtime advertises, dispatches, and contains failure. It transports
nothing, authorizes no call, and ships no concrete tools. A `contract` derives the advertised
parameter schema and validates arguments; `parameters` alone remains descriptive. Caller identity
in the execution context is consumer-asserted and forwarded without verification. Each trust
decision belongs to the invoking consumer, to a policy layer, or to the tool itself. Progress
reporting belongs there too: it is a property of the invoking consumer's execution context, one
layer up — the `@orkestrel/mcp` package's execution context carries a progress reporter — never of
the tool contract itself.

Source: [`src/core`](../src/core). Published through `@orkestrel/tool`.

## Surface

### Types

The data shapes, from [`types.ts`](../src/core/types.ts). Every property is readonly, and an
optional field the caller did not supply is absent from the value. A `Shape` cell holds an
interface's data members as bare names in braces, `?` marking an optional member and `plus`
introducing its call-signature members, and a type alias's own type literal with a union's arms
escaped as `\|`. An extended interface's name comes before `plus`, with the members it adds after.

| Name                   | Kind      | Shape                                                                                                                                                           | Summary                                                                          |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ToolDefinition`       | interface | `{ name, title?, description?, parameters?, annotations? }`                                                                                                     | Describes a tool as advertised to a caller.                                      |
| `ToolCall`             | interface | `{ id, name, arguments }`                                                                                                                                       | Describes one request to run a named tool.                                       |
| `ToolSuccess`          | interface | `Success<unknown> plus { id, name }`                                                                                                                            | Reports the successful outcome of executing a `ToolCall`.                        |
| `ToolFailure`          | interface | `Failure<string> plus { id, name }`                                                                                                                             | Reports the failed outcome of executing a `ToolCall`.                            |
| `ToolOptions`          | interface | `{ name, title?, description?, summary?, parameters?, contract?, annotations?, execute }`                                                                       | Configures an executable tool.                                                   |
| `ToolInterface`        | interface | `ToolDefinition plus { summary? } plus execute`                                                                                                                 | Represents an executable tool: its advertised definition plus its local handler. |
| `ToolManagerInterface` | interface | `{ count, emitter } plus add, tool, tools, definitions, execute, remove, clear, destroy`                                                                        | Represents a registry of executable tools with per-call error isolation.         |
| `ToolManagerEventMap`  | type      | `{ readonly add: readonly [tool: ToolInterface]; readonly remove: readonly [tool: ToolInterface]; readonly clear: readonly [tools: readonly ToolInterface[]] }` | Names the events a tool registry publishes.                                      |
| `ToolManagerOptions`   | interface | `{ on?, error? }`                                                                                                                                               | Configures a tool registry's initial listeners and error handling.               |
| `ToolResult`           | type      | `ToolSuccess \| ToolFailure`                                                                                                                                    | Represents the outcome of executing a `ToolCall`.                                |
| `ToolContext`          | interface | `{ signal, caller? }`                                                                                                                                           | Carries the signal and consumer-asserted identity for an execution.              |
| `ToolAnnotations`      | interface | `{ pure?, untrusted?, consequential? }`                                                                                                                         | Describes the observable effects and content of a tool.                          |
| `ToolErrorCode`        | type      | `'SCHEMA' \| 'ARGUMENTS'`                                                                                                                                       | Identifies a schema conflict or an argument validation failure.                  |
| `ToolErrorContext`     | interface | `{ faults? }`                                                                                                                                                   | Carries the structured faults behind an argument validation failure.             |

`ToolInterface` and `ToolManagerInterface` list every member they declare or inherit. The
call-signature members of each are documented under [Methods](#methods); the readonly `count` of
`ToolManagerInterface` reports how many tools are registered and is a Surface member with no
method row. Its readonly `emitter` publishes `add`, `remove`, and `clear` with the payloads
declared by `ToolManagerEventMap`. The `ToolManagerOptions` fields supply initial `on` hooks
and an `error` handler for listener throws.

### Validators

The call-envelope guard, from [`validators.ts`](../src/core/validators.ts). In a guard
table a `Shape` cell holds the type the guard narrows to.

| Name         | Kind     | Shape      | Summary                                                                                                              |
| ------------ | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `isToolCall` | function | `ToolCall` | Determines whether an unknown value is structurally a `ToolCall`, staying total for malformed and adversarial input. |

### Helpers

The advertised-definition projection, from [`helpers.ts`](../src/core/helpers.ts).

| Name               | Kind     | Signature                                 | Summary                                                                                                                                                                                        |
| ------------------ | -------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolToDefinition` | function | `(tool: ToolInterface) => ToolDefinition` | Projects a tool onto the plain definition advertised to a caller, advertising an authored `summary` in place of the full description and carrying `parameters` and `annotations` by reference. |

### Factories

From [`factories.ts`](../src/core/factories.ts) — the constructor-free way to reach `Tool` and
`ToolManager`.

| Name                | Kind     | Signature                                                | Summary                                                                                                                                                                                                                    |
| ------------------- | -------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTool`        | function | `(options: ToolOptions) => ToolInterface`                | Creates an executable tool bound to the supplied handler, returned as a `ToolInterface` so a call site holds the published contract rather than the `Tool` class.                                                          |
| `createToolManager` | function | `(options?: ToolManagerOptions) => ToolManagerInterface` | Creates an empty registry that advertises definitions and executes calls with per-call error isolation, returned as a `ToolManagerInterface` so a caller holds the published contract rather than the `ToolManager` class. |

### Classes

The implementing classes, from [`Tool.ts`](../src/core/tools/Tool.ts) and
[`ToolManager.ts`](../src/core/tools/ToolManager.ts) — each documented in full under its own
heading following this table.

| Name          | Kind  | Summary                                                                                |
| ------------- | ----- | -------------------------------------------------------------------------------------- |
| `Tool`        | class | Binds an executable tool definition to a handler.                                      |
| `ToolManager` | class | Represents an insertion-ordered tool registry with per-call error isolation.           |
| `ToolError`   | class | Reports a schema conflict or argument validation failure with a machine-readable code. |

### `Tool`

The implementing class of `ToolInterface`, from [`Tool.ts`](../src/core/tools/Tool.ts). It
copies the fields it was given — omitting each optional one that was not supplied — and keeps
the handler in a private field, so a tool's advertised shape cannot drift from what it executes.
An explicit parameter schema and the execution context are forwarded by reference. Without a
contract, the argument record retains its identity too. A contract compiles at construction and
derives the parameter schema through the contract package's projection. The compiled contract
checks arguments before handler entry and supplies its parsed copy to the handler.
`Tool` deliberately does not catch: a handler that throws throws, and per-call isolation belongs
to the registry that dispatched it. See [`## Methods`](#methods) for its public call surface.

### `ToolManager`

The implementing class of `ToolManagerInterface`, from
[`ToolManager.ts`](../src/core/tools/ToolManager.ts). It stores tools in a name-keyed map and owns
an emitter for registry changes. Tools stay in insertion order, `tools()` and `definitions()` return fresh readonly arrays rather
than a view of that map, and every projection is computed on demand so a mutation can never
leave a stale copy behind. It is the only place a call can fail into a result instead of an
exception. See [`## Methods`](#methods) for its public call surface.

### `ToolError`

The error class from [`errors.ts`](../src/core/errors.ts) extends `Error`. Its constructor takes
`code`, `message`, and optional `context`. Direct tool execution throws an `ARGUMENTS` error with
the full fault report in `context.faults`; the manager contains it as a message. Use `isToolError`
to narrow a caught value. See [Contract validation and errors](#contract-validation-and-errors)
for an executed example.

| Name          | Kind     | Shape       | Summary                                                                      |
| ------------- | -------- | ----------- | ---------------------------------------------------------------------------- |
| `isToolError` | function | `ToolError` | Checks whether a value is a tool error, containing hostile prototype access. |

## Methods

The public call-signature members of each behavioral interface, one table per interface.

#### `ToolInterface`

| Method    | Returns                       | Summary                                                                           |
| --------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `execute` | `Promise<unknown> \| unknown` | Runs the tool's handler with the caller-supplied arguments and execution context. |

#### `ToolManagerInterface`

| Method        | Returns                                        | Summary                                                  |
| ------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `add`         | `void`                                         | Registers one tool.                                      |
| `tool`        | `ToolInterface \| undefined`                   | Finds one registered tool by name.                       |
| `tools`       | `readonly ToolInterface[]`                     | Lists the registered tools in insertion order.           |
| `definitions` | `readonly ToolDefinition[]`                    | Lists the definitions advertised to a caller.            |
| `execute`     | `Promise<ToolResult \| readonly ToolResult[]>` | Executes one call with error isolation.                  |
| `remove`      | `boolean`                                      | Removes one registered tool.                             |
| `clear`       | `void`                                         | Removes every registered tool.                           |
| `destroy`     | `void`                                         | Removes every tool and releases the emitter's listeners. |

`add`, `execute`, and `remove` each take one value or a readonly batch of them. A batch `add`
registers every tool, later entries winning over earlier ones with the same name; a batch
`execute` answers in input order with one result per call; a batch `remove` reports `true` only
when every named tool was present.

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

`new Tool({ … })` builds the same thing; reach for `createTool` where a call site must not name
a class.

An explicit `parameters` schema is descriptive runtime data, forwarded by reference. Declaring
`required` in that schema tells the caller what to send; it does not validate the payload. Use the
`contract` option when the runtime must validate arguments.

A handler receives a `Readonly<Record<string, unknown>>` and a required `ToolContext`.
Without a contract, that record is the original input; with a contract, it is the parsed value.
The context holds an `AbortSignal` and optional unverified caller identity. Handlers may omit
unused parameters from their declaration. Every invocation still supplies the arguments and the
context. A direct `tool.execute(args, context)` call must provide the context; the manager creates
one when its caller omits it. Handlers may return synchronously or asynchronously.

When one was authored, `definitions()` projects the tool's `summary` as `description`, advertising
it in place of the full description. The full text stays on the tool for direct lookup through
`tools.tool('add')?.description`.

## The registry

A registry is a working set, not a global. Build one per caller, fill it with the tools that
caller is allowed to reach, and hand out its definitions:

```ts
import { Tool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add(add) // the tool defined earlier
tools.add([
	new Tool({ name: 'echo', execute: (args) => args.value }),
	new Tool({ name: 'now', description: 'Current epoch milliseconds.', execute: () => Date.now() }),
])

tools.count // 3
tools.tool('add') // the exact instance that was registered, or undefined
tools.tools() // a fresh readonly array, in insertion order
tools.definitions() // the same order, projected to plain ToolDefinition values

tools.remove('echo') // true — the tool was present
tools.remove(['now', 'ghost']) // false — 'ghost' was never registered, so not every name succeeded
tools.clear() // back to empty
```

Order is insertion order, and adding a name that already exists replaces the stored tool without
moving it — the sequence a caller sees stays stable while a tool behind a name is swapped.
Remove a name and add it again and it lands at the end, because the name is genuinely new to the
map. In a batch, later entries win over earlier ones with the same name.

`definitions()` projects fresh plain objects on every call: `name`, followed by present `title`,
`description`, `parameters`, and `annotations` fields. A summary replaces the advertised
description. The schema and annotations retain their original identities. Nothing that arrives on
a definition is a live handle on the registry — advertising cannot be used to reach the handlers.

## Calls and results

A call arrives as unstructured input from somewhere else, so check the envelope before trusting
it, then execute:

```ts
import { isToolCall } from '@orkestrel/tool'

tools.add(add) // restores the tool removed by the registry example

const incoming: unknown = {
	id: 'call-1',
	name: 'add',
	arguments: { left: 2, right: 3 },
}

if (isToolCall(incoming)) {
	const result = await tools.execute(incoming)
	if (result.success) {
		result.value // 5
	} else {
		result.error // the failure message
	}
}

const batch = await tools.execute([
	{ id: '1', name: 'add', arguments: { left: 2, right: 3 } }, // → { id: '1', name: 'add', success: true, value: 5 }
	{ id: '2', name: 'ghost', arguments: {} }, // → { id: '2', name: 'ghost', success: false, error: 'tool not found: ghost' }
])
```

`isToolCall` validates the envelope only: the `id`, the `name`, and that `arguments` is a plain
record. The guard ignores extra fields without reading them. A call carries no execution context.
The registered tool's contract, when configured, validates the arguments during execution.

Execution context travels as a separate argument. This package adds neither the signal nor caller
identity to definitions, schemas, calls, or results. A handler can explicitly return a context
member as its own value. The context and caller identity reach the handler unchanged.

Execution always resolves for a call whose members are plain values; a call whose `id` or `name`
accessor throws when read makes `execute` reject, because no correlated result can be built
without them. An unknown name becomes `tool not found: <name>`; a synchronous throw and an
asynchronous rejection are both contained; an `Error` contributes its `message`, and any other
thrown value is converted with `String`; a value whose conversion itself throws — a hostile
`toString`, a throwing `message` getter, a null-prototype object — becomes the fixed message
`Unknown thrown value`. Success and failure never mix in one result: a successful call carries
`value` even when that value is `undefined`, `null`, `0`, `''`, or `false`, and a failed call
carries `error`. Narrow on `success` to distinguish the two; a present success value is not
necessarily meaningful or truthy.

An in-process caller needing a typed error can call `tools.tool(name)`, then
`tool.execute(args, context)` inside its own `try`/`catch`.

A batch is dispatched concurrently and answered in input order, with each call whose members are
plain values isolated from its siblings — a handler failure never voids the batch, a call whose
`id` or `name` accessor throws when read rejects it, and duplicate ids stay distinct positional
calls rather than collapsing into one. That isolation is what lets a caller feed every result back
to whatever produced the calls and let it react to the failures itself.

The sections that follow are independent examples.

## Execution context

For versions from 0.0.15, `caller` lives on `ToolContext` instead of `ToolCall`. A handler whose
second parameter is annotated `unknown` still compiles and receives the context object rather
than the caller value. Update such a handler to read `context.caller`.

Pass a context when the caller owns cancellation or carries an asserted identity:

```ts
import type { ToolContext } from '@orkestrel/tool'
import { createTool, createToolManager } from '@orkestrel/tool'

const controller = new AbortController()
const context: ToolContext = { signal: controller.signal, caller: { subject: 'reader' } }
const tools = createToolManager()
tools.add(createTool({ name: 'signal', execute: (_args, execution) => execution.signal.aborted }))
const call = { id: 'signal-1', name: 'signal', arguments: {} }
const result = await tools.execute(call, context)
result // { id: 'signal-1', name: 'signal', success: true, value: false }
controller.abort('request ended')
const aborted = await tools.execute(call, context)
aborted // { id: 'signal-1', name: 'signal', success: false, error: 'request ended' }
```

The manager creates a non-aborted signal for each execution that omits a context. A batch shares
one context, whether supplied or created. Before entering each registered handler, the manager
checks the signal. A batch dispatches every call in one synchronous pass, so an abort raised after
dispatch reaches only handlers that observe the signal. A synchronous abort inside the dispatch
pass prevents later handler entry. An already-aborted signal produces a failure with
`String(signal.reason)`, or `aborted` if the reason is `undefined`. An unknown tool still produces
its not-found failure.
After handler entry, the handler must observe the signal and stop its own work. The manager awaits
that handler and contains its throws as usual; an abort does not force a running handler to settle.

## Contract validation and errors

A contract compiles at construction. Its schema projects to `parameters` through
`schemaToParameters(createContract(shape).schema)` from `@orkestrel/contract`; an undefined
projection leaves parameters absent. Supplying `contract` and `parameters` together throws a
`ToolError` with code `SCHEMA`.

The contract's `explain` method reports parse faults before the handler runs. It accepts coercible
values, such as a numeric string for a number. After a clean report, `Tool.execute` forwards
`contract.parse(args)`: the owned, normalized copy in the schema's types, with undeclared keys
dropped. A handler cannot rely on undeclared input keys being present. Without a contract, the
raw argument record is forwarded unchanged. A parse fault throws `ToolError` with code
`ARGUMENTS`. The message names the first fault's path and reason, then its expected and received
values when the fault carries them; a constraint fault also names its constraint and limit when
present. Array paths join with `.`; string paths stay unchanged. A root array path is empty, so
its message starts with `: `. The error's `context.faults` holds the full report. A `variant` fault
carries `variants`, appended as `; variants <n>`; a `oneOf` fault carries `matched`, appended as
`; matched <n>`. A missing field carries expected alone. Contract construction errors from the
dependency propagate unchanged. If parsing returns a value that isn't a record after a clean
explanation, execution throws `ToolError` with code `ARGUMENTS` and message
`Arguments did not parse`, without `context`, before handler entry.

Use the guard to narrow an error at the direct execution boundary:

```ts
import type { ToolErrorCode, ToolErrorContext } from '@orkestrel/tool'
import { numberShape, objectShape } from '@orkestrel/contract'
import { ToolError, createTool, isToolError } from '@orkestrel/tool'

const tool = createTool({
	name: 'amount',
	contract: objectShape({ amount: numberShape() }),
	execute: (args) => args.amount,
})
const context = { signal: new AbortController().signal }
tool.execute({ amount: 3 }, context) // 3
try {
	tool.execute({ amount: 'invalid' }, context)
} catch (error) {
	if (!isToolError(error)) throw error
	const code: ToolErrorCode = error.code
	code // 'ARGUMENTS'
	const details: ToolErrorContext | undefined = error.context
	details?.faults?.[0]?.reason // 'type'
	error.message // 'amount: type; expected number; received "invalid"'
}
const conflict = new ToolError('SCHEMA', 'Choose contract or parameters')
conflict.code // 'SCHEMA'
isToolError(conflict) // true
isToolError(new Error('Unrelated')) // false
```

The manager contains this same argument refusal as a `ToolFailure`; it carries the message rather
than the error instance or fault report. `ToolError` extends `Error`, exposes its readonly `code`
and optional readonly `context`, and inherits the standard error methods.

## Advertising title and annotations

A title supplies display text. Annotations describe observable effects and content: `pure` reports
no state changes the caller can observe, `untrusted` reports that the result can carry content the
tool did not author, and `consequential` reports an effect the caller must confirm. These are
claims by the tool author; this runtime neither verifies them nor enforces confirmation.

Project the advertising fields while keeping the detailed description on the tool:

```ts
import type { ToolAnnotations } from '@orkestrel/tool'
import { createTool, toolToDefinition } from '@orkestrel/tool'

const annotations: ToolAnnotations = { pure: true, untrusted: false, consequential: false }
const tool = createTool({
	name: 'echo',
	title: 'Echo',
	description: 'Return the supplied value unchanged.',
	summary: 'Echo a value.',
	annotations,
	execute: (args) => args.value,
})
const definition = toolToDefinition(tool)
definition.title // 'Echo'
definition.description // 'Echo a value.'
definition.annotations === annotations // true
```

## Patterns

### Observe registry changes

Subscribe through the `on` option or `tools.emitter.on`. Each event describes the registry at the
moment it is published. A listener that mutates the registry re-enters synchronously; its own
events publish before the outer call resumes.

An addition publishes `add` with the map holding that exact tool. A replacement keeps its
registration position and publishes `remove` with the previous instance while the replacement
is already installed. A listener must not read absence from the map to confirm that removal.
After the removal listeners return, `add` publishes only if the map still holds that exact
replacement. Removing a present name publishes `remove` after deletion; a missing name publishes
nothing. Batches apply their operations in argument order.
Each `clear` call publishes one `clear` with the removed tools in registration order, including
an empty array when the registry was empty. Execution publishes no registry events.

Collect event names while registering, replacing, removing, and clearing a tool:

```ts
import { createTool, createToolManager } from '@orkestrel/tool'

const events: string[] = []
const tools = createToolManager({
	on: {
		add: () => events.push('add'),
		remove: () => events.push('remove'),
		clear: () => events.push('clear'),
	},
})
tools.add(createTool({ name: 'echo', execute: (args) => args.value }))
tools.add(createTool({ name: 'echo', execute: () => 'replacement' }))
tools.remove('echo')
tools.clear()
events // ['add', 'remove', 'add', 'remove', 'clear']
tools.destroy()
tools.emitter.destroyed // true
```

Listeners run synchronously. A listener throw reaches the optional `error` handler as
`(error, event)` and does not prevent sibling listeners. Without an error handler, the emitter
swallows listener throws. Destruction clears the registry while listeners remain attached,
destroys the emitter, then empties the map again without publishing. It returns with an empty
registry even if a `clear` listener added a tool. An emission already underway delivers to its
remaining snapshotted listeners, even when a listener destroys the registry before its siblings
run. A destroyed registry publishes nothing; later additions still update its tool map, and
later subscriptions do nothing.

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

- [`guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection, the `ToolInterface` ↔ `Tool` and `ToolManagerInterface` ↔ `ToolManager` method bijections, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Anatomy of a tool` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences, including `Observe registry changes`, and asserts the values their comments claim against byte-equal transcriptions.
- [`Tool.test.ts`](../tests/src/core/tools/Tool.test.ts) — definition binding, optional-field omission, argument and context identity, contract validation, error diagnostics, return values, and direct error propagation.
- [`ToolManager.test.ts`](../tests/src/core/tools/ToolManager.test.ts) — insertion order, overwrite and removal lifecycle, definition projection, cancellation, context sharing, and isolated single and batch execution. Event proofs cover registration before `add`, ordered batch additions, the installed replacement during `remove`, `remove` before replacement `add`, synchronous replacement re-entry, a third instance a removal listener installs during a replacement, deletion before `remove`, silent missing names, ordered batch removals, populated and empty `clear` snapshots by identity, emitter destruction after clearing, an empty registry after teardown listeners re-add a tool, sibling delivery during mid-emission destruction, silent additions after destruction, and execution without registry events.
- [`factories.test.ts`](../tests/src/core/factories.test.ts) — factory construction, working instances, initial registry hooks in publication order, sibling listener isolation, and listener-error forwarding.
- [`helpers.test.ts`](../tests/src/core/helpers.test.ts) — definition projection: summary preference, omitted optional keys, projected key order, schema identity, title and annotations forwarding, and a fresh object per call.
- [`validators.test.ts`](../tests/src/core/validators.test.ts) — tool-call envelope boundaries: incomplete calls, wrong field types, and non-record arguments.
- [`errors.test.ts`](../tests/src/core/errors.test.ts) — `isToolError` recognition, unrelated-value rejection, and hostile prototype containment.

## See also

- [`README.md`](README.md) — the guides index.
- [`contract.md`](contract.md) — the dependency mirror for `@orkestrel/contract`, whose total guards back `isToolCall` and the registry's overload narrowing.
- [`AGENTS.md`](../AGENTS.md) — the repository's coding and documentation contract.
