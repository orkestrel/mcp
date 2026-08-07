---
paths:
  - 'src/**/*'
  - 'app/**/*'
  - 'tests/**/*'
  - 'guides/**/*'
  - 'package.json'
  - 'vite.config.ts'
  - 'tsconfig.json'
  - '.agents/skills/**/*'
  - '.claude/skills/**/*'
---

# Research, hardening, and completion rules

## Evidence before change

- Research is mandatory when the user requests it, when comparing an upstream/protocol/legacy implementation, or when current external behavior materially affects design.
- Use current primary sources for external capabilities and exact installed declarations/guides for dependencies. Separate verified fact from inference.
- Read authoritative types and named decision-bearing implementation files first-hand. Delegate bulk supporting context, not the owning design decision.
- Treat existing code, tests, `old/`, branches, and copied projects as evidence rather than authority.
- Build a capability/defect matrix before a broad API or production-readiness change. Every row ends as implement, repair, retain, or intentionally exclude with evidence.

## Falsification

A review that reads a diff finds what the diff shows; a review that tries to break named claims finds what the diff hides. Code that has already passed diff review several times can still carry a defect nobody has yet tried to trigger.

- State an audit's subject as a numbered list of the claims the work makes, never as “review this diff”. Each claim is falsifiable: a property some concrete input, state, or interleaving could show false.
- Instruct the auditor to attempt refutation rather than confirmation. A claim it cannot break is reported CONFIRMED with the evidence that convinced it; a claim it breaks is reported BROKEN with the exact failing input, state, or interleaving, plus the smallest correct fix.
- Derive claims from what the change asserts under adverse conditions: cancellation, restart, concurrency, partial failure, hostile input, resource exhaustion, and the orderings a happy path never reaches.
- Read the installed declaration or implementation of every substrate a claim depends on. A claim about `stop()` is unfalsifiable until you know what `stop()` does when the status is not the one the caller assumed.
- An audit returning only confirmations puts the brief on trial rather than the subject. It is a legitimate result, not a presumptive failure: telling an auditor that a clean round means it did not try is an instruction to manufacture a finding, and a manufactured finding costs a fix unit, an argument, and the credibility of the true findings beside it. Instead re-read the claims and ask whether any could have been falsified by evidence the round actually had. If none could, the claims were descriptive and the round proved nothing — sharpen them and re-run. If they could have been and were not, the pass stands. Name the claims you could not break either way, so the next round knows what has already been attacked.
- A repaired claim is a new claim, not a settled one. Re-ask it at every entry point that reaches the same rule, not only the door the defect arrived through. A fix verified where it was found and assumed everywhere else ships the defect at every other door — and the engine that wrote the fix is the least able to see this, because re-verifying where the fix is feels like verifying the fix.
- An instrument is not evidence until it has failed. A probe, comparison, or matrix that has never produced its failing verdict cannot tell a sound subject from a broken tool. Pair it with a negative control that must report failure, run under the same conditions. An identity check whose control reports “same” has measured nothing.
- A negative control drawn from the same population as the subject cannot find a gap in the population boundary. Controls sampled from the constructs an instrument already handles prove it discriminates among those constructs and say nothing about the class it silently cannot reach. Name the instrument's membership rule, draw a control from outside the population that rule defines, and state what the controls established and what they did not. An instrument certified only from the inside is trusted exactly where it has never been tested.
- An instrument that settled a claim is adopted as a test before the work it settled is accepted. The probe that proved a fix, carrying the negative control that proved the probe, is that fix's regression guard; leaving it in a scratch directory discards the most expensive evidence of the round and guarantees the next round re-derives it. A verification that runs once is a rehearsal, not a gate.

## Ecosystem reuse

The root laws on inspecting declared `@orkestrel/*` capabilities, reusing a matching primitive, and updating every consumer without shims bind here without restatement. They leave this file the judgment calls:

- Prove the semantic difference before keeping a local variant; similar names are not evidence of different behavior.
- Downstream friction is valid evidence of a reusable upstream defect, not automatic proof. Fix the lowest package that owns the general mechanism and keep product policy downstream.
- Never re-export a dependency's symbol to soften a consumer's import.

## Production hardening

- Translate “enterprise-grade” or “production-ready” into an explicit risk/seam matrix covering applicable inputs, states, failures, cleanup, cancellation, concurrency, resource ownership, hostile boundaries, environment isolation, serialization/restore, and package consumption.
- Test observable invariants at each applicable seam with real implementations.
- Use dedicated real-service projects for external model/service behavior. Require readiness and tune each request to the smallest robust proof.
- Audit test discovery, counts, skipped/todo tests, cleanup, and assertion adequacy; passing discovered tests alone is insufficient.
- Inspect public exports, declarations, supported runtime targets, and generated outputs.
- A claim that a surface works with an external client stays unproven until one representative real client of that class has driven it end to end. Protocol tests prove the protocol, not the integration.
- Add an independent adversarial review for security, destructive paths, concurrency, protocols, or untrusted external input.

## Completion

The root completion law — finish every in-scope capability now, leave no TODO, deferral, or hidden follow-up, and run the applicable repository skill for comprehensive work — binds here without restatement. It leaves this file two obligations:

- Perform a final centralization/wrapper/test-helper/text-integrity sweep after implementation and before gates.
- Local quality gates and relevant output inspection are required evidence.
