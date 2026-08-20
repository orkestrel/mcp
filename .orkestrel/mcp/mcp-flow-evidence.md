# MCP — executed evidence for the ownership finding

Taken by the Orchestrator on 2026-08-20, on the host, because the subjective lane holds no exec tool
and left three sub-points unresolved. Instruments: `scratchpad/flow-probe.mjs` and
`scratchpad/flow-fix-probe.mjs`, both against `node:stream.PassThrough`.

## What the lane could not settle

| Question | Answer |
| -------- | ------ |
| Does a bare `resume()` leave `readableFlowing` true with zero `data` listeners? | **Yes.** `flowing=true listeners=0` |
| Does attaching then detaching a `data` listener leave it flowing? | **Yes.** `flowing=true listeners=0` |
| Does `on('data')` after an explicit `pause()` restart the flow? | **No.** `delivered=0 flowing=false` |
| Is a second reader starved when the first pauses? | **Yes.** first=1 second=1 after the second write |

The third answer breaks a sentence in the commit message as well as the code. `48ded67` rules that
`pause()` is not a seizure because "a caller who wants to read again resumes or attaches a listener".
Attaching does not restart flow after an explicit pause. Only `resume()` does, and a starved caller
receives no signal telling it to.

## The shipped rule against two candidates

`transport()` records ownership both ways, attaches a handler, then releases under each rule.
Correct answers: the sole reader is paused; every other case is not.

```
=== rule: count (shipped: ownership from listenerCount at start) ===
  sole reader                    ownsCount=true  remaining=0 paused=true
  caller resumed first           ownsCount=true  remaining=0 paused=true    WRONG
  caller attached then detached  ownsCount=true  remaining=0 paused=true    WRONG
  second reader after start      ownsCount=true  remaining=1 paused=true    WRONG

=== rule: flow (readableFlowing !== true at start AND listenerCount === 0 at release) ===
  sole reader                    ownsFlow=true  remaining=0 paused=true
  caller resumed first           ownsFlow=false remaining=0 paused=false
  caller attached then detached  ownsFlow=false remaining=0 paused=false
  second reader after start      ownsFlow=true  remaining=1 paused=false
```

The shipped rule is wrong in three of four cases. The candidate is right in all four.

## The lane's proposed remedy is incomplete

The subjective lane proposed deleting `#ownsFlow` and testing `listenerCount('data') === 0` at
release alone. That is the `remaining` column above. It fixes the second-reader case and still pauses
in "caller resumed first" and "caller attached then detached", because both leave zero listeners at
release. A listener count answers "is anyone reading now"; it never answers "was this stream already
flowing before I touched it". Both questions have to be asked, at the two different moments where
each is answerable.

Brief the fix as the conjunction, not as the lane's single test.
