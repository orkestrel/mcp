# HS-U2: the modern seam's refusal split

## Role and engine

Sol `implementer`, GPT-5.6 Sol, inside `codex exec --sandbox workspace-write` at `/home/user/mcp`.

## Objective

Make the bare modern dispatcher answer a request honestly by what the request is: legacy-shaped,
modern-but-undeclared, malformed, or unsupported.

## Context

- Read before editing: the `AGENTS.md` file, `.claude/rules/typescript.md`,
  `.claude/rules/tests.md`, and the `tmp/handshake-reconciliation.md` file (binding; § Q4 is this
  unit's ruling).
- The tree is committed and clean at commit 9693563, with HS-U1 landed. No other writer runs.
- Verified code facts, 2026-08-20: `MCPServer.#modern` answers a request whose
  `parseRequestContext` fails with `-32602 Invalid params: malformed modern request metadata`
  (near `src/core/MCPServer.ts:370-385`); `isModernRequest` is exported from
  `src/core/validators.ts` and already imported by `MCPLegacy`; the method registry is readable
  as `this.#methods.method(request.method)`; `JSONRPC_METHOD_NOT_FOUND` and
  `JSONRPC_INVALID_PARAMS` live in `src/core/constants.ts`. Line numbers can drift; re-locate by
  pattern.
- External corroboration, cited in the retained research: the reference Python SDK client falls
  back from `server/discover` to legacy `initialize` on `-32601`, so the refusal this unit
  writes is the fast half of cross-era interop.
- Standing sandbox conditions: no network; in-process runs are reliable; every proof here is
  in-process.

## The items

1. **The split.** In `MCPServer.#modern`, before `parseRequestContext`, branch on
   `isModernRequest(request)`. When the request carries no modern version declaration:
   - if the modern seam does not register the method, answer
     `-32601 Method not found: <method>`;
   - if it does register the method, answer
     `-32602 Invalid params: request declares no protocol version`.
   When the declaration is present: keep `parseRequestContext`, keep
   `-32602 Invalid params: malformed modern request metadata` for failing grammar, and keep the
   `MCP_UNSUPPORTED_VERSION` answer with `{ supported, requested }` for a well-formed
   unsupported revision. The error text names the fact and stops — no factory name and no remedy
   in the wire message.
   - Verify the registry read at that point inverts no dispatcher invariant (it is a lookup with
     no side effect); if you find one it does invert, stop and report per the deviation contract.
2. **The proofs.** In `tests/src/core/MCPServer.test.ts`, in-process through `dispatch` (and
   `handle` where the file's existing shape covers it):
   - a legacy `initialize` against a bare `createMCPServer` answers `-32601` with
     `Method not found: initialize`;
   - a `tools/list` carrying no version declaration answers `-32602` naming the absent
     protocol-version declaration;
   - a request carrying the version key with failing grammar still answers the malformed
     message, and a well-formed unsupported revision still answers `MCP_UNSUPPORTED_VERSION`
     carrying `supported` and `requested`;
   - the existing notification silence and every current passing assertion stay green.

## Unknowns

- Whether `#modern` is the sole door for the misrouted legacy shape, or `server/handlers.ts`
  carries a sibling site (its `:101` region prints the same message). Sweep for the message
  text, rule each site by the same split, and report every site you changed or left with the
  reason.

## Scope

- Owned: `src/core/MCPServer.ts`, `tests/src/core/MCPServer.test.ts`, and — only if the sweep in
  Unknowns finds a sibling refusal site that misroutes the same shape — `src/server/handlers.ts`
  with its mirrored test file `tests/src/server/handlers.test.ts`.
- Off-limits: `src/core/MCPClient.ts`, `src/core/MCPLegacy.ts`, `src/core/parsers.ts`,
  `src/core/validators.ts`, `guides/mcp.md`, `README.md`, `tmp/` except your own report file.
- Permission limits: no commit, no push, no install, no `git checkout`/`restore`/`stash`/
  `reset`/`clean`, no secrets.

## Execution

You perform this assignment directly and spawn no agent.

## Deviation contract

A conflict with the Q4 ruling stops the unit with the standard report. Message punctuation and
test placement inside the owned files are yours to decide and record.

## Output

Write your report to the `tmp/hs-u2-report.md` file: per item what changed with file:line, the
sweep's per-site rulings, the red/green readings for the new proofs, then `git diff --stat` and
`git status --short`. No process diary.

## Acceptance criteria (in order)

1. `npm run lint:check` exits 0.
2. `npm run check` exits 0.
3. `npm run format:check` exits 0 (run `npm run format` first if needed).
4. `MCPServer.ts` carries no `legacy` or `MCPLegacy` spelling.
5. The scoped run over each owned test file exits 0; paste the count lines.

## Review evidence

The actual `git diff --stat` and `git status --short` output in the report.
