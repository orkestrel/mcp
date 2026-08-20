# MCP-AUDIT: successor audit of the @orkestrel/mcp readiness campaign

## Role and engine

Role `analyst`. Engine GPT-5.6 Sol, high effort, sandbox `read-only`, rooted at `/workspace/mcp`.
You are the objective lane. Every change under audit was written by Opus 5, so you are an engine
that did not write it.

## Objective

Rule on the numbered claims in this brief and return per-claim verdicts with executed evidence.
The package is about to be published as `0.0.20`. A claim you cannot substantiate is a FAIL, not a
courtesy PASS.

## Read first, in this order

1. `AGENTS.md`
2. `.claude/rules/quality.md` — the Falsification law owns the method and the evidence each verdict
   carries
3. `.claude/rules/writing.md` and `AGENTS.md` § Writing — the count ban lives there
4. `.agents/skills/orkestrel-falsify/SKILL.md` — it fixes the verdict shape, the value set, and the
   single terminal line. Follow it exactly.
5. `guides/mcp.md` — the governing spec for this package

## Context

- The campaign range is `a177f8e..HEAD`. `a177f8e` is the `0.0.19` release commit.
- The source-only diff is staged at `tmp/codex/mcp-audit-src.diff` for convenience. It is a
  convenience copy, not the authority: run `git diff a177f8e..HEAD -- <path>` yourself for anything
  you rule on, and read the working tree for current state.
- The tree is committed and clean at the time of dispatch. `git status` reporting only untracked
  `tmp/` files is the expected state.
- Gates ran green immediately before this dispatch: `format:check`, `lint:check`, `check`, `build`,
  and every `test:*` project, plus `scaffold audit` reporting no drift. Do not re-run the suite; the
  claims below are about substance the gates do not reach.
- The sandbox is read-only and the network is unshared. You cannot write a probe file, install, or
  fetch. Where a claim needs an executed reading you cannot take, say so in that claim's verdict and
  name the exact command that would take it. Do not guess the reading.
- Vendored files are off-limits as subjects: `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/`,
  `.codex/`, `.cursor/`, `configs/helpers.ts`, `scripts/*.sh`, `tests/config.test.ts`,
  `tests/policy.test.ts`, `tests/setupPolicy.ts` are owned by `@orkestrel/scaffold` and restored by
  `repair`. Report a defect in one as a scaffold finding; never as an mcp fix.

## Known findings — do not spend budget rediscovering these

- `guides/mcp.md:1594` claims "the repository law suite computes the legacy-owning module set from
  the tree and requires it to EQUAL that list in both directions". `tests/policy.test.ts` contains
  no occurrence of `legacy`, and it is a vendored file that cannot carry a package-specific rule.
  The claim is already ruled false. Claim 7 asks you for the class, not this instance.
- The `unbind()` call in the stdio transport repair has no observer: removing both call sites
  reddens nothing across the suite. Already ruled redundant rather than wrong.

## The claims

Rule on each. Number your verdicts to match.

**Claim 1.** Every transport in `src/` releases on `close()` exactly what it acquired on open —
listeners, timers, sockets, streams, and stream state — and holds nothing after `close()` that keeps
the Node event loop alive. Subjects: `src/server/transports/*.ts`, `src/browser/transports/*.ts`.

**Claim 2.** `src/server/transports/StdioServerTransport.ts` and `StdioClientTransport.ts` restore
`process.stdin` to the flow state they found, for every entry state the stream can be in, and remove
every listener they added and no listener they did not add.

**Claim 3.** `guides/mcp.md`'s statement of `env` semantics for the stdio client transport is true of
the shipped code: a provided `env` merges over `process.env` per key rather than replacing it, and
the published surface exposes no way to withhold `process.env` from the spawned child. Rule also on
whether the guide states the security consequence plainly enough for a reader to act on it.

**Claim 4.** `package.json`'s `exports`, `types`, and `typesVersions` shape resolves every declared
subpath under `node10`, `node16`, `bundler`, and `nodenext`, and the guide's account of the entry
points matches what `package.json` declares.

**Claim 5.** The `test:distribution` project exercises the packed artifact rather than the source
tree, and would fail if the packed artifact lost a declared export or shipped a file the manifest
does not list.

**Claim 6.** No prose in this repository states a count of a set the repository can add to, and no
prose names a list item by its position. Scope: `README.md`, `guides/*.md` **excluding every mirror**
(a mirror is any `guides/*.md` other than `guides/mcp.md` and `guides/README.md`; mirrors are
refetched by `scaffold catalog` and are not this package's prose), every TSDoc and comment under
`src/`, `app/`, and `tests/`, and every file under `.orkestrel/`. An external identifier is not a
count: an RFC section number, a JSON-RPC error code, a protocol revision date, and a version number
all stay. Sweep case-insensitively and across inflections, and name the pattern and the paths behind
your result including a clean one.

**Claim 7.** No claim in `guides/mcp.md` asserts that a suite executes a check the suite does not
execute. The known finding at line 1594 is one instance; find the rest of the class or establish
there are none. For each hit, name the guide line, the suite it names, and the command proving the
check is absent.

**Claim 8.** `guides/mcp.md` and `src/` are in parity in both directions: every backticked public API
the guide names resolves to a real public export, and every public export of the three barrels is
documented. State which direction the existing `test:guides` project already proves and which it does
not, and rule only on the gap.

**Claim 9.** The campaign's own artifacts under `.orkestrel/` contain no instruction, rule, or ruling
that belongs in a durable file and exists nowhere else. Per `.agents/orchestration.md` § Dispatch
anatomy, a campaign artifact is evidence and never a rule's home.

## Unknowns

- Whether Claim 5's distribution project can distinguish a manifest defect from a build defect. I do
  not know, and I have not read that project closely. Report what it actually reaches.
- Whether any transport's release path is observable by an existing test. Where a release is
  unobservable, say so; an unobservable repair is a finding of its own class, not a PASS.

## Scope

Read-only. Own nothing. Edit nothing. Spawn nothing. Perform this assignment directly.

## Output

The verdict shape `.agents/skills/orkestrel-falsify/SKILL.md` fixes, and nothing else. Per-claim
verdicts with executed evidence, findings numbered in one sequence, and the single terminal line the
skill specifies. No process diary.
