# Handshake design round: negotiation, legacy reach, and pin fidelity

## Objective

Rule on the measured handshake defects below and specify the fix precisely enough to brief one
writing unit: which code, defaults, examples, and tests change, and what each change must preserve.

## Context

- Repository: `/home/user/mcp` at commit 26024f5, clean. The package publishes as
  `@orkestrel/mcp` 0.0.20 in the wave now being prepared; the registry serves 0.0.19.
- Read before ruling: the `AGENTS.md` file, `.claude/rules/names.md`,
  `.claude/rules/typescript.md`, `.claude/rules/patterns.md`, `.claude/rules/documentation.md`,
  the `guides/` directory's negotiation and transport material, and the evidence under
  `tmp/handshake-evidence/` (its `README.md` names each file).
- The load-bearing code sites, verified 2026-08-20:
  - `src/core/MCPClient.ts:219-222` — with `options.timeout` configured the discovery probe
    deadline is `Math.min(options.timeout, DEFAULT_MCP_PROBE_TIMEOUT)`; unconfigured it is
    `DEFAULT_MCP_REQUEST_TIMEOUT`. `src/core/constants.ts:181-184` sets those to 30_000 and 50.
  - `src/core/types.ts:2482` documents the cap, so the behavior is stated, not accidental.
  - `src/core/MCPServer.ts:370-385` — the `#modern` path answers a request whose context fails
    `parseRequestContext` with `-32602 Invalid params: malformed modern request metadata`. A
    legacy `initialize` sent to a bare `createMCPServer` takes this path and this refusal.
  - `src/server/factories.ts:369-376` — the `createStdioServer` flagship example composes
    `createStdioServer(createMCPServer(...))` with no `createMCPLegacy` wrapper.
  - `src/core/MCPClient.ts:216-217` — `#pin = options.version`, `#offer = options.version ??
    MCP_MODERN_VERSION`.

## The measured defects

1. **The flagship composition is legacy-incapable and misnames its refusal.** A server built
   exactly from the `createStdioServer` example answers a legitimate legacy `initialize` with
   `-32602 malformed modern request metadata`. Reproduced identically on the packed 26024f5
   tarball and on registry 0.0.19 (wire taps in the evidence folder). Probe's working composition
   wraps with `createMCPLegacy`.
2. **A configured request timeout silently shrinks the discovery window to 50ms.** Over a spawned
   stdio server's cold start the discover answer arrives after the deadline (the tap shows a
   valid, late reply), so: unpinned clients silently downgrade to 2025-11-25; a client pinned to
   2026-07-28 fails outright. Configuring `timeout: 15_000` — shorter than the unconfigured
   30_000 — moves the probe deadline from 30_000 to 50.
3. **A pin outside the supported set is silently ignored.** A client pinned to `'2020-01-01'`
   connected and negotiated 2025-11-25 (the drive4 control). The `version` option is typed
   `MCPVersion`, so TypeScript rejects the literal, but the runtime accepts any string and
   negotiates a different revision than the caller named.

## The questions

- Q1. Where does legacy reach belong: `createMCPServer` answering `initialize` natively, the
  transport factories wrapping `createMCPLegacy` by default, or the examples and guide teaching
  the wrapper explicitly? Name what each choice costs, including the API-surface and layering
  laws, and what the sibling transport examples teach today.
- Q2. What is the correct probe-deadline law? Name the invariant (what an unpinned client must
  negotiate against a modern server, on a cold spawned transport and on a warm one), the bound
  (what the fallback must still deliver when the server is genuinely legacy-only), and where the
  deadline derives from. Rule on whether `DEFAULT_MCP_PROBE_TIMEOUT = 50` survives at all.
- Q3. What is pin fidelity? Rule on refusing an unsupported pin at construction versus at
  `connect`, and on what a pinned client does when the server cannot serve that revision —
  including whether the current bogus-pin behavior can survive under the absence-is-`undefined`
  and boolean-behavior laws.
- Q4. What replaces the `malformed modern request metadata` refusal for a recognizably legacy
  request reaching a modern-only dispatcher?
- Q5. Which tests bind the rulings? The drive matrix in the evidence folder is the candidate
  regression instrument; name the project each proof belongs to per `.claude/rules/tests.md` and
  `.claude/rules/workspace.md`.

## Execution

You perform this analysis directly and spawn nothing. You are one blind lane of an adversarial
design pass; argue your lane and do not hedge toward a compromise you expect the other lane to
want.

## Output

Per question: your ruling, the exact change it implies (file, symbol, behavior), what it
preserves, and the failure mode it forecloses. Then a proposed unit decomposition with
independently checkable acceptance criteria. End with the single line `LANE COMPLETE`. No process
diary.
