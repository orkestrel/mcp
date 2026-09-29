# Review verdict: mcp M1 `bridge-refresh`

Seam: the WebMCP bridge refresh to the 2026-09-29 draft, written by GPT-6 Astra (`codex exec`, third launch) against `tmp/units/m1-bridge-refresh.md`. One review pass by the `reviewer` role on Opus 5.5 over ten numbered claims (`tmp/units/m1-claims.md`) and the diff (`tmp/units/m1-diff.patch`, 8 files, +367/−61). Gates the Orchestrator ran outside the Codex sandbox before the review: `npm run check` 0; `test:src:browser` 173 passed, 2 skipped; `test:guides` 202 passed.

## Verdicts

| Claim | Verdict | Ruling |
| --- | --- | --- |
| 1 `debugging` optional, never invented | CONFIRMED | held |
| 2 `adopt` excludes by default, includes on request | CONFIRMED | held |
| 3 subscriptions at construction, republication, removal on destroy | CONFIRMED | held; amended by R1 and R2 |
| 4 IDL spelling, guard unchanged | CONFIRMED on its terms | amended by R2 |
| 5 the double follows the specification's algorithms | BROKEN | accepted: an already-aborted caller rejects before activation; the tool's abort steps run before `toolcancel`; a caller abort in flight rejects `executeTool` with the reason (the pre-existing resolution divergence closed with it) |
| 6 no `cancel` spelling, no polling | CONFIRMED | held |
| 7 guide truthful and rule-conforming | BROKEN on the letter | accepted: five bare-token sentences and two missing links |
| 8 only the named assertions changed | CONFIRMED | held; `factories.test.ts` ownership ratified |
| 9 reading dates | CONFIRMED | held |
| 10 no nested function, no re-export, one-word members | CONFIRMED | held |

## Outside findings

- R1 (accepted): the bridge read `event.toolName` from an event any script can dispatch; the listener is typed `(event: Event) => void` and `isWebMCPToolEvent` narrows before emitting. Ruling 3 of the unit is amended accordingly.
- R2 (accepted): the overload's narrowed listener type broke the interface's structural fit for an `EventTarget`-backed registry; the same signature change restores it and the fixture's widening reverts.
- R3 (accepted): `WebMCPToolEvent` gains its exact-type assertion beside the other wire types.

## Fix round

Every finding carries the reviewer's prescription verbatim, so the round closes with a mutation probe on the guard line rather than a second review. The fix is applied by a `builder` on Sonnet in this checkout; the Orchestrator reruns the gates and the probe.
