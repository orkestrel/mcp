1. **BROKEN**

   - **F1.** `MessagePortTransport` leaves its anonymous `message` and `messageerror` listeners attached after `close()`. The executed probe reported `before: message=1 messageerror=1` and `after transport.close: message=1 messageerror=1`; its named-listener control reported `armed=1 released=0`. Retain both listener functions, remove them during close, and clear the registered callbacks.
   - **F2.** `WebSocketClientTransport.close()` does not settle a `start()` call made while the socket is connecting. The executed EventTarget-based protocol probe reported `subject=pending open-listeners=1 error-listeners=1` after close. The rejection control reported `control=rejected`. Retain a handshake cleanup and rejector so close removes both temporary listeners and settles the promise.
   - **F3.** Full `StdioClientTransport` release is not observable with the installed substrate. Its pump awaits `child.lines`, while the installed `@orkestrel/process` 0.0.3 contract permits `destroy()` to resolve with `lines` and `exit` outstanding when a descendant retains an inherited pipe. Existing tests do not exercise that state. Re-pin to a process release that closes inherited-pipe iteration, then add a live descendant-release test.

2. **BROKEN**

   - **F4.** `StdioServerTransport` does not restore all three `readableFlowing` entry states. The executed matrix produced `null → false`, `false → false`, and `true → true`, while restoring caller-owned listener counts in every case. Existing tests explicitly accept `null → false`. Node exposes no public operation that restores `null` after data consumption starts, so the invariant must narrow to preserving flowing versus non-flowing state unless the transport adopts a different consumption mechanism.

3. **CONFIRMED**

   The guide states that `env` merges with the inherited environment, cannot withhold unspecified variables, and requires callers to scrub the parent or trust the child. The source passes `env` without enabling isolated replacement. The executed substrate probe retained an inherited variable under merge mode and removed it under replacement mode. The transport probe also confirmed that a merged child remained writable.

4. **BROKEN**

   - **F5.** The package does not support every declared subpath under legacy TypeScript `node` resolution. `package.json` has no `typesVersions` mapping or top-level `types`, and the distribution test explicitly marks legacy `node` support false while accepting `node16`, `nodenext`, and `bundler`. The guide accurately documents this limitation, but the claim remains false. Add legacy subpath mappings or narrow the support claim to the documented resolution floor.

5. **BROKEN**

   - **F6.** The distribution test installs and inspects the packed artifact, checks missing export targets, compares runtime keys with declaration names, and pins declaration counts. It does not inspect the packed file inventory or compare it with the manifest allowlist, so an unexpected shipped file can escape detection. It also reports target absence without classifying manifest versus build-output defects. Read `files` from the `npm pack --json` result, compare them with the allowed package paths, and add a planted-file negative control. The direct inventory command `npm pack --dry-run --json --ignore-scripts` was unavailable because npm failed with `EROFS` under `/root/.npm/_cacache/tmp`.

6. **BROKEN**

   - **F7.** The scoped source sweep found prohibited prose in `.orkestrel` and test comments, including “ships six transports,” “Seven findings across six transport classes and one factory,” “false in eight places,” “17 rows,” “The third answer,” “the second assertion,” and “first expectation.” The control search for `twentieth` returned no matches. Replace extensible-set totals and positional references with stable names, and remove accepted campaign artifacts.

7. **BROKEN**

   - **F8.** The guide says the parity gate resolves every backticked API name. `tests/guides.test.ts` checks Surface rows in both directions and named imports in TypeScript fences, but contains no general inline-code-span parity check. Narrow that sentence to the implemented checks or add the missing scan.
   - **F9.** Beyond the acknowledged false statement at line 1594, the Tests and Contract sections separately claim that the policy suite checks legacy-removability and `MCPServer` absence. `rg -n -i 'legacy|MCPLegacy|MCPServer' tests/policy.test.ts` returned no matches. Remove those duplicate claims or cite the tests that perform the checks; do not add package-specific behavior to the vendored policy suite.

8. **CONFIRMED**

   Existing guide tests prove both directions between public barrels and Surface rows, and validate named imports in every TypeScript fence. The executed prose scan found no nonexistent package public API among simple identifier code spans outside fences. The unresolved-looking names were host globals, a script name, wire fields, TypeScript syntax, or external contracts. A planted `isRecord` control was detected and correctly absent from the public surface. The remaining gap is arbitrary backticked prose, matching the claim.

9. **BROKEN**

   - **F10.** `.orkestrel/mcp/clean-brief.md` contains durable general rules forbidding counts of extensible sets and positional list-item names, but the search across `AGENTS.md`, `.claude/rules`, `.agents`, guides, source, tests, and package metadata found no promoted copy. A control found the flow-state ruling in both campaign evidence and shipped source, proving the search can distinguish promoted guidance. This is a **SCAFFOLD** finding: promote the prose rules into the scaffold-owned writing policy, regenerate dependents, and remove the campaign artifacts at acceptance.

VERDICT: FAIL — 7 broken, 0 unresolved, 0 not-evidenced, 0 findings outside the claims