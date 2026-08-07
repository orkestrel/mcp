---
name: orkestrel-falsify
description: Run an adversarial audit round against work that already looks finished — write the subject as numbered falsifiable claims, dispatch independent auditors instructed to break them rather than confirm them, reconcile their evidence, and rule. Use before accepting a fix round, before a version bump or publication, when green gates are the only evidence a change works, when a defect has recurred across rounds, or whenever a review would otherwise read a diff and agree with it.
---

# Falsify

Green gates prove a suite ran. They prove nothing about the claim the work makes. This skill is for
the moment when everything passes and the work is still not known to be right.

## Load authority

1. `AGENTS.md`.
2. `.claude/rules/quality.md`, especially **Falsification** — the laws governing auditor behaviour.
   This skill prescribes the round; that section prescribes the conduct inside it. Do not restate it.
3. The governing guide/spec for the subject.
4. `references/brief.md` before writing a brief; `references/reconcile.md` before ruling.

## When a round is warranted

Run one when the work is finished and the evidence is weak in a specific way:

- gates are green and nothing has attacked the claim;
- a fix round is about to be accepted, especially one whose author reported success;
- a version is about to be bumped, packed, or published;
- the same defect class has now appeared in more than one round;
- a self-declared "sound, unchanged, no fix needed" verdict is load-bearing.

Do not run one for a typo, a mechanical rename, or work whose failure would be immediately visible.

## Write the brief

The brief is the instrument. A weak brief produces a confirming review no matter which auditor reads
it. Follow `references/brief.md`. What this skill adds beyond the conduct law:

- Every re-run is a **successor**, not a restatement. It carries what the previous round closed so
  nothing is re-reported, and it adds claims that attack **the previous round's own rulings**.
- The brief names what the round **decides**. An auditor that does not know the stakes calibrates to
  politeness.
- Unknowns are named as unknowns, with how the auditor reports back on them.

The claim form itself is the Falsification law's — read it there. The **verdict shape** below is this
skill's, because `CLAUDE.md` assigns it here; everything else about auditor conduct is the law's.

## Evidence, by subject type

The brief supplies the evidence its subject actually has. Requiring a diff for a subject that has no
diff is a rule the brief cannot satisfy.

| subject                                 | required evidence                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| a code change                           | the actual diff and the actual status output; omitting either is a dispatch deviation |
| a rendered or externally driven surface | the capture portfolio as primary, source as corroboration                             |
| a policy, design, or process proposal   | the proposal, the canon it must satisfy, and the record of what motivated it          |

**A subject can occupy more than one row; supply every row it occupies.** A ruling whose fixes
already landed as edits is both the third row and the first, and withholding the diff on the grounds
that the subject is "a proposal" leaves the auditor unable to check whether a fix changed anything
nobody claimed.

## Run the round

- **Verify every authority the brief references exists in the tree the auditor is rooted in.** A
  brief that points at a rule file, section, or guide the executor cannot find delivers nothing while
  looking like authority — and it fails silently, because an auditor does not report a heading it
  never saw. Check before dispatch; propagate the missing file rather than restating its contents in
  the brief. This is the reason restatement felt necessary, and it is the wrong cure.
- Dispatch **two independent auditors on one identical brief**, blind to each other, and reconcile
  yourself. Engine and role selection are the orchestration contract's, not this skill's. A round run
  with one auditor is a deviation; record it rather than glossing it.
- Supply the evidence the subject type requires, per the table above.
- Auditors are read-only and spawn nothing.
- Blind reports are **immutable**. Nothing an auditor returns is edited, merged, or revised — by
  anyone, including the auditor — once it has been returned.

## Verdict shape

Every auditor in every round returns exactly this, and nothing else. One shape makes rounds
comparable; a round that invents its own cannot be read against the last one.

1. **Numbered verdicts**, one per claim, in the brief's order. Exactly one of four values:

   | value           | meaning                                                                                | evidence                                                                                                                                                      |
   | --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `CONFIRMED`     | attacked and it held                                                                   | as the Falsification law requires                                                                                                                             |
   | `BROKEN`        | falsified                                                                              | as the Falsification law requires — note it says _input, **state, or interleaving**_, so a concurrency claim is falsified by an interleaving, not by an input |
   | `UNRESOLVED`    | cannot be decided from the evidence available                                          | what would settle it                                                                                                                                          |
   | `NOT-EVIDENCED` | a claim about a rendered or externally driven surface the supplied capture cannot show | which capture is missing                                                                                                                                      |

   The first two rows defer; only the last two are this skill's, because the law does not name them.
   `BROKEN` and `UNRESOLVED` are **separate**: a claim nobody could decide has not been falsified,
   and it cannot supply the fields falsification requires. `NOT-EVIDENCED` is the token the
   `analyst` and `reviewer` charters already require; it is kept, not re-invented.

2. **Findings fitting no claim**, if any, each substantiated to the same standard as `BROKEN`.

3. **One terminal line**, and only one:

   ```text
   VERDICT: PASS — <m> of <m> confirmed, no findings outside the claims
   VERDICT: FAIL — <n> broken, <u> unresolved, <e> not-evidenced, <x> findings outside the claims
   ```

   **`PASS` requires all four to be true**: every claim `CONFIRMED`, nothing `UNRESOLVED`, nothing
   `NOT-EVIDENCED`, and no substantiated finding outside the claims. A single substantiated finding
   forces `FAIL` no matter how the numbered claims landed — otherwise a round can report a real
   defect and still emit the word that authorises the release.

No process diary. No summary of what was read.

## When a round comes back all-confirmed

The Falsification law governs this: the brief goes on trial, not the subject. Apply it, and if the
claims turn out to have been descriptive, the successor brief is where the sharper ones go.

## Reconcile and rule

Follow `references/reconcile.md`. The obligations that are not delegable:

- **Reproduce every sharp finding yourself** before acting on it. An auditor's finding is a
  hypothesis until the orchestrator has run it.
- **A disagreement between auditors is rarely a tie to average.** It is usually two correct answers
  to two different questions. Find the question each one answered.
- **Bound every finding**: state what is _not_ broken, and why the adjacent behaviour that looks the
  same is correct. An audit that reports everything is as useless as one that reports nothing.
- **Bound the fix before briefing it.** Establish what over-correcting would break, and include that
  in the fix brief as a constraint.
- Drop, on the record, any finding neither auditor can substantiate.

## Accept, or run it again

The threshold is **a round that returns nothing it can substantiate** — not a round with a short
list, and never green gates.

A round that finds something is a success, not a delay. The alternative is a consumer finding it
after publication, when the version number is already spent.

When a fix round follows, its auditor must be an engine that did not write it, and the next round's
brief is the successor of this one.
