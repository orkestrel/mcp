# MCP at `48ded67` — independent gate evidence

`verifier`, Sonnet, read-only, dispatched by the Orchestrator. Every working-tree-discarding git
command was prohibited by name; the tree was clean before and after.

| Gate                        | Exit | Note |
| --------------------------- | ---- | ---- |
| `npm run format:check`      | 0    | |
| `npm run lint:check`        | 0    | |
| `npm run check`             | 0    | |
| `npm run build`             | 0    | |
| `npm test`                  | 0    | |
| `npm run test:distribution` | —    | **The script does not exist in this package.** |
| `npx scaffold audit`        | 0    | 0 of 131 planned paths drifted; bytes at 113, existence at 4, nothing at 14 |

Test counts as the runner printed them:

- `test:src` (`src:core`, `src:browser`, `src:server`): 28 files, 1010 tests
- `test:policy`: 1 file, 86 tests
- `test:config`: 1 file, 28 tests
- `test:guides`: 1 file, 125 tests
- `test:conformance`: 1 file, 4 tests
- `test:integration`: 1 file, 4 tests

No flake, no re-run.

## The missing distribution gate

`npm test` composes `test:src`, `test:policy`, `test:config`, `test:guides`, `test:conformance`, and
`test:integration`. There is no distribution step. Sibling packages `@orkestrel/process` and
`@orkestrel/probe` each carry a `tests/distribution.test.ts` that packs the package, installs the
tarball into a directory outside the repository, and asserts every `exports` target exists, that both
module formats load for both entries, and that each entry's runtime export set equals its `.d.ts`
value-declaration set. This package has no such proof.

## Manifest at the tip

`version` 0.0.19. Runtime dependencies: `@orkestrel/contract` `^0.0.12`, `@orkestrel/emitter`
`^0.0.7`, `@orkestrel/process` `^0.0.3`, `@orkestrel/sse` `^0.0.5`, `@orkestrel/tool` `^0.0.11`,
`@orkestrel/websocket` `^0.0.9`.

## `@orkestrel/process` surface this package reaches

```
src/server/transports/StdioClientTransport.ts:8:import { Process } from '@orkestrel/process/server'
src/server/transports/StdioClientTransport.ts:9:import { PROCESS_GRACE } from '@orkestrel/process'
```
Two symbols, neither renamed by that package's 0.0.4 rename. Two further mentions are prose.

## Renamed-surface sweep

No hit for `runSync`, `RunResult`, `RunOptions`, or `RunInput`. Every `runner` match names a test
runner or the `@modelcontextprotocol/conformance` runner, not a sibling package's API.

## Barrels

`src/core/index.ts` carries 17 rows and `src/server/index.ts` carries 14, every one of the form
`export * from './<module>.js'`. No named, default, namespace, or type-only row in either.

## The two commits under audit

`ec65d53` — 5 files, 209 insertions, 9 deletions: the brief, `src/server/factories.ts`,
`src/server/transports/StdioServerTransport.ts`, and two test files.

`48ded67` — 2 files, 21 insertions, 3 deletions: `src/server/transports/StdioServerTransport.ts` and
its test.
