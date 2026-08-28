# Codec

> The fleet's byte-to-text codings, as sound `encode` / `decode` / guard triples over `string` and
> `Uint8Array` — RFC 4648 Base64, base64url, and hex, beside the UTF-8, ISO-8859-1, Windows-1252,
> and UTF-16LE charsets — and a `measure*` that answers a coding's byte-side size question without
> producing those bytes. Zero runtime dependencies, no error type, no options, no class. Source:
> [`src/core`](../src/core). Published through `@orkestrel/codec`.

A coding is a spec-named, stateless mapping with one canonical spelling per input, written as an
`encode*` that produces only the canonical form, a `decode*` that accepts exactly that form and
answers `undefined` for everything else, and an `is*` guard that names the exact set the partial
direction accepts. Every function is pure ES: no `atob` / `btoa`, no `Buffer`, no `TextEncoder` /
`TextDecoder`, no `node:*`, and no dependency on another `@orkestrel` package. Totality is
implemented rather than caught: codec ships no error type, no options bag, no class, and no type of
its own. It is not a formats package — it does not compress, frame a stream, escape a document, map
values into a store, or read JSON.

## The families

The families are fixed, and their direction belongs to the coding rather than to the package.
`encode*` moves a value toward the coding's wire form and `decode*` moves it back toward the native
one. For the RFC 4648 faces the wire form is text, so `encodeBase64` takes bytes and returns a
string. For a charset the wire form is bytes, so `encodeUTF8` takes a string and returns bytes.
Nothing else inverts with it: both faces keep the same two laws, each written in the direction its
own `encode*` points.

Which side can fail belongs to the coding too. An RFC 4648 `encode*` cannot fail, so its `decode*`
carries every refusal. A charset can refuse on either side, and each one refuses where its
specification leaves a gap: `encodeUTF8` refuses ill-formed text, `decodeUTF8` refuses a
non-shortest spelling, `encodeLatin1` refuses a code unit past 0xFF, and `decodeLatin1` refuses
nothing at all.

`is*` takes an `unknown` and never throws. It attaches to its coding's **partial** direction,
because a guard names the set some function refuses and a total function has no set to name. The
RFC 4648 guards therefore sit on the text side and narrow to `string`. `isUTF8`, `isWindows1252`,
and `isUTF16LE` sit on the bytes side and narrow to `Uint8Array`, because those decoders can refuse.
`isLatin1` sits on the text side and narrows to `string`, because that coding's decoder is total and
its encoder is the only side with a set to name. UTF-8's text side ships no guard at all:
`text.isWellFormed()` is ECMA-262's own name for exactly the strings `encodeUTF8` accepts, so a
guard there would be a wrapper adding nothing.

`measure*` answers the coding's byte-side size question without doing the work that produces those
bytes, and `undefined` for a text the coding refuses — the name `@orkestrel/websocket` already
carries for `measureWebSocketFrame`, which reads a frame's declared payload length off the buffer
without buffering the payload. Which text a measure reads belongs to the coding, the same way the
encode direction does: an RFC 4648 face's wire form is text, so its measure takes wire text and
answers the byte length its decoder would allocate; UTF-8's wire form is bytes, so `measureUTF8`
takes native text and answers the wire byte length its encoder would write. Each row in the
following Measures table spells its own law.

A face's guard and its partial function are one grammar: the guard answers by asking that function,
so the set the guard names and the set the function accepts cannot drift apart. A measure is the one
family that cannot ask. Its reason to exist is that it never allocates the bytes, so it walks the
grammar itself and the suite holds the two walks against each other — a measure that produces the
bytes has measured nothing.

## Surface

### Codings

The RFC 4648 faces: the codings from [`helpers.ts`](../src/core/helpers.ts) and the guards from
[`validators.ts`](../src/core/validators.ts). `Base64` names the §4 coding, `Base64URL` the §5 one,
and `Hex` the §8 one; the alphabets and the reverse lookups behind them are module data, not public
API, because publishing an alphabet invites hand-rolling the coding it belongs to.

| Name              | Kind     | Signature                                                | Behavior                                                                                                                                                             |
| ----------------- | -------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encodeBase64`    | function | `(bytes: Uint8Array) => string`                          | Spells `bytes` in the RFC 4648 §4 alphabet (`+`, `/`) with `=` padding — the canonical form, and the only form `decodeBase64` accepts. Total: encoding cannot fail.  |
| `decodeBase64`    | function | `(text: string) => Uint8Array<ArrayBuffer> \| undefined` | Reads back exactly what `encodeBase64` writes. Every other text — wrong alphabet, whitespace, wrong padding, a non-zero unused trailing bit — is `undefined`.        |
| `isBase64`        | function | `(value: unknown) => value is string`                    | True for exactly the strings `decodeBase64` answers bytes for. Total on any value: a number, `null`, or a byte sequence is false rather than a throw.                |
| `encodeBase64URL` | function | `(bytes: Uint8Array) => string`                          | Spells `bytes` in the RFC 4648 §5 url alphabet (`-`, `_`) with the padding removed — the canonical form, and the only form `decodeBase64URL` accepts. Total.         |
| `decodeBase64URL` | function | `(text: string) => Uint8Array<ArrayBuffer> \| undefined` | Reads back exactly what `encodeBase64URL` writes. A padded text, a `+`, or a `/` belongs to the §4 face and is `undefined` here.                                     |
| `isBase64URL`     | function | `(value: unknown) => value is string`                    | True for exactly the strings `decodeBase64URL` answers bytes for. Total on any value.                                                                                |
| `encodeHex`       | function | `(bytes: Uint8Array) => string`                          | Spells `bytes` in the RFC 4648 §8 alphabet, lowercase, two digits per byte — the canonical form, and the only form `decodeHex` accepts. Total: encoding cannot fail. |
| `decodeHex`       | function | `(text: string) => Uint8Array<ArrayBuffer> \| undefined` | Reads back exactly what `encodeHex` writes. An uppercase digit, an odd length, a `0x` prefix, whitespace, and any foreign character are `undefined`.                 |
| `isHex`           | function | `(value: unknown) => value is string`                    | True for exactly the strings `decodeHex` answers bytes for. Total on any value.                                                                                      |

### Measures

The byte-side size a text carries, read off the text itself — from
[`helpers.ts`](../src/core/helpers.ts), each beside the coding it measures. Every RFC 4648 face here
has one: `measureBase64` reads the §4 face, `measureBase64URL` the §5 face, and `measureHex` the §8
face, each answering the byte length its own decoder would allocate. `measureUTF8` reads the charset
face, and it reads it the other way round: native text in, wire bytes counted. The remaining
charsets have none, for the reason the membership bar gives.

`computeBytes` in `@orkestrel/scaffold` counts UTF-8 bytes too, and it answers a different question
for a lone surrogate: the three bytes `TextEncoder` writes for the replacement character, where
`measureUTF8` answers `undefined`. That divergence is deliberate — it is the strict door this
package keeps on every face — and a consumer wanting the replacement count calls the counter that
produces it.

| Name               | Kind     | Signature                               | Behavior                                                                                                                                                        |
| ------------------ | -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measureBase64`    | function | `(text: string) => number \| undefined` | The byte length `decodeBase64` would return for `text`, without allocating those bytes; `undefined` for exactly the texts `decodeBase64` refuses.               |
| `measureBase64URL` | function | `(text: string) => number \| undefined` | The byte length `decodeBase64URL` would return for `text`, without allocating those bytes; `undefined` for exactly the texts `decodeBase64URL` refuses.         |
| `measureHex`       | function | `(text: string) => number \| undefined` | The byte length `decodeHex` would return for `text`, without allocating those bytes; `undefined` for exactly the texts `decodeHex` refuses.                     |
| `measureUTF8`      | function | `(text: string) => number \| undefined` | The UTF-8 byte length `encodeUTF8` would write for `text`, without allocating those bytes; `undefined` for exactly the ill-formed strings `encodeUTF8` refuses. |

### Charsets

The charset faces, whose wire form is bytes rather than text: the codings from
[`helpers.ts`](../src/core/helpers.ts) and the guards from
[`validators.ts`](../src/core/validators.ts). `UTF8` names the RFC 3629 coding, `Latin1` the
ISO/IEC 8859-1 one, `Windows1252` the code page, and `UTF16LE` the little-endian UTF-16 form.
`WINDOWS_1252_HIGH` — the written-out 0x80-0x9F table both Windows-1252 functions read — is module
data rather than public API, for the reason the Base64 alphabets are.

| Name                | Kind     | Signature                                                | Behavior                                                                                                                                                                               |
| ------------------- | -------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encodeUTF8`        | function | `(text: string) => Uint8Array<ArrayBuffer> \| undefined` | Spells `text` in the RFC 3629 shortest form. `undefined` for exactly the ill-formed strings — a lone surrogate has no UTF-8 spelling.                                                  |
| `decodeUTF8`        | function | `(bytes: Uint8Array) => string \| undefined`             | Reads back exactly what `encodeUTF8` writes. An overlong, an encoded surrogate, a code point past U+10FFFF, and a truncated sequence are `undefined`. A leading BOM is kept as U+FEFF. |
| `isUTF8`            | function | `(value: unknown) => value is Uint8Array`                | True for exactly the byte sequences `decodeUTF8` answers text for. Total on any value: a string, a sibling view kind, or a proxy is false rather than a throw.                         |
| `encodeLatin1`      | function | `(text: string) => Uint8Array<ArrayBuffer> \| undefined` | Writes each code unit as the byte of the same value, which is the whole of ISO/IEC 8859-1. `undefined` when a code unit exceeds 0xFF.                                                  |
| `decodeLatin1`      | function | `(bytes: Uint8Array) => string`                          | Reads each byte as the code point of the same value. Total: every byte names a character, so this decoder has no failure mode and no `undefined` return.                               |
| `isLatin1`          | function | `(value: unknown) => value is string`                    | True for exactly the strings `encodeLatin1` answers bytes for. This coding's guard names the encode side, because its decoder refuses nothing. Total on any value.                     |
| `encodeWindows1252` | function | `(text: string) => Uint8Array<ArrayBuffer> \| undefined` | Inverts the mapping `decodeWindows1252` reads. `undefined` for a character outside the code page's image, every C1 control included.                                                   |
| `decodeWindows1252` | function | `(bytes: Uint8Array) => string \| undefined`             | Identity for 0x00-0x7F and 0xA0-0xFF, and the written-out high table between them. Bytes 0x81, 0x8D, 0x8F, 0x90, and 0x9D name no character in the code page and are `undefined`.      |
| `isWindows1252`     | function | `(value: unknown) => value is Uint8Array`                | True for exactly the byte sequences `decodeWindows1252` answers text for. Total on any value.                                                                                          |
| `encodeUTF16LE`     | function | `(text: string) => Uint8Array<ArrayBuffer> \| undefined` | Writes each code unit low byte first. `undefined` for exactly the ill-formed strings — an unpaired surrogate is no UTF-16 sequence.                                                    |
| `decodeUTF16LE`     | function | `(bytes: Uint8Array) => string \| undefined`             | Reads two bytes per code unit, low byte first. An odd length and an unpaired surrogate are `undefined`. A leading FF FE is kept as U+FEFF.                                             |
| `isUTF16LE`         | function | `(value: unknown) => value is Uint8Array`                | True for exactly the byte sequences `decodeUTF16LE` answers text for. Total on any value.                                                                                              |

## The laws

Each face keeps two laws, and the suite drives both as sweeps rather than as spot vectors. Each law
is written in the direction the face's own `encode*` points, so an RFC 4648 face reads it over bytes
and text where a charset reads it over text and bytes.

**The round-trip law.** `decode*(encode*(value))` deep-equals `value`, for every input the face
admits, the empty one included. On the §4 face that reads `decodeBase64(encodeBase64(bytes))`; on
the UTF-8 face it reads `decodeUTF8(encodeUTF8(text))`.

**The canonical-form law.** `encode*(decode*(wire))` returns `wire`, for every wire form the face's
guard admits. On the §4 face the wire form is text and the law reads
`encodeBase64(decodeBase64(text)) === text`; on the UTF-8 face it is bytes and the law reads
`encodeUTF8(decodeUTF8(bytes))` deep-equals `bytes`.

A measure keeps one law, over every string rather than over the admitted ones alone, and it is
written in the direction that measure reads.

**The sound-triple law.** `measure*(text)` equals the length of the bytes the function producing
them would return, or `undefined` where that function refuses `text`. On the RFC 4648 faces the
producer is the decoder, so the law reads `measureBase64(text) === decodeBase64(text)?.length`; on
the UTF-8 face the producer is the encoder, so it reads
`measureUTF8(text) === encodeUTF8(text)?.length`. An admitted text pins the length; a refused text
pins `undefined` on both sides. The suite drives `measureBase64`, `measureBase64URL`, and
`measureHex` against their decoders across each face's sweep population, membership rows, measure
rows, octet-prefix encodings, and the mutant population, and drives `measureUTF8` against
`encodeUTF8` across the well-formed text population, the ill-formed rows, and every boundary code
point — so a divergence between the two walks reddens on the texts those populations reach.

The canonical-form law is the one that does the work. It says a decoder may accept only the
spelling its own encoder produces, which rules out every lenient door at once: the wrong alphabet
and embedded whitespace close for both faces. Missing or excess padding and a length off the
four-character group boundary are the §4 doors; §5 spells the same closure its own way — the
unpadded url alphabet, refusing `=`, `+`, and `/` outright, and refusing any `length % 4 === 1`
residue, which no amount of padding can complete. And a non-zero unused trailing bit closes last,
for both faces alike. That last refusal is the one consumers meet: `'aa=='` carries a set bit in
the sextet the padding discards, so `decodeBase64('aa==')` is `undefined` and `isBase64('aa==')` is
false. `'aQ=='` is the canonical spelling of the byte `'aa=='` was reaching for, and it decodes.
The url face refuses `'aa'` for the same reason, and admits `'aQ'`.

The §8 face has fewer doors to close and closes them the same way. Hex carries no padding and no
unused trailing bit, so an odd length and a character outside the alphabet are the whole refusal
set — and uppercase is one of those characters. RFC 4648 §8 prints its table uppercase; this
package's canonical spelling is lowercase. That is a deliberate departure, and the canonical-form
law is what forces a choice at all: one spelling per input, so the package picks the one the fleet
already produces — `bytesToHex` in `@orkestrel/scaffold`, the digest hex in `@orkestrel/mcp`, and
Node's own `digest('hex')`. So `decodeHex('AB')` is `undefined` and `isHex('AB')` is false, by the
argument that refuses `'aa=='`: `'AB'` re-encodes as `'ab'`, so admitting it would break the law.
`'ab'` is the spelling that decodes. `'0xab'` is `undefined` because the prefix is a notation
around the coding rather than part of it, and `'abc'` is `undefined` because a byte takes two
digits.

### The charset doors

A charset closes its doors in the direction its own specification leaves open, so the refusals do
not read alike across the four faces.

UTF-8 closes on both sides. `encodeUTF8` refuses ill-formed text, which is exactly what
`String.prototype.isWellFormed` reports false for — a lone surrogate is a UTF-16 artifact with no
UTF-8 spelling, and inventing one is what the replacement character does. `decodeUTF8` refuses every
non-canonical byte spelling: an overlong such as `C0 80` or `E0 80 80`, an encoded surrogate such as
`ED A0 80`, a code point past U+10FFFF such as `F4 90 80 80`, a truncated sequence such as `E2 82`,
a continuation byte with no lead, and a lead byte the grammar has no width for.

ISO-8859-1 closes on one side only. Every byte names a character, so `decodeLatin1` is total and
returns a bare `string`; the only door is `encodeLatin1`, which refuses a code unit past 0xFF.
`isLatin1` guards that door because it is the only one there is.

Windows-1252 closes where the code page itself stops. Bytes 0x81, 0x8D, 0x8F, 0x90, and 0x9D are
undefined slots, so `decodeWindows1252` refuses them. The defined mapping is a bijection — no
character is reachable from two bytes — so `encodeWindows1252` is its exact inverse and refuses
every character outside the image, which includes all of U+0080-U+009F because no defined slot
reaches a C1 control.

UTF-16LE closes on the two things the wire form can get wrong: an odd length, which completes no
code unit, and a surrogate the byte stream leaves unpaired — a lead with nothing after it, a lead
followed by a BMP code unit, and a trail with no lead alike.

### The BOM stance

A byte order mark is data here, not a signal. `EF BB BF` decodes to U+FEFF on the UTF-8 face and
`FF FE` decodes to U+FEFF on the UTF-16LE face, in leading position exactly as anywhere else, and
each encodes back to those bytes. The round-trip law forces it: a decoder that dropped a leading BOM
would answer a text whose re-encoding is shorter than the bytes it was given, and no amount of
documentation makes that a round trip. A consumer that wants the mark removed removes it, the same
way a consumer wanting lenient Base64 normalizes first.

### Where this package parts from WHATWG

The platform's own codings are the obvious oracle for these faces, and they disagree with this
package in ways worth naming rather than discovering.

- **`TextDecoder('latin1')` is not ISO-8859-1.** The WHATWG `latin1` label is an alias for
  windows-1252: the decoder reports `encoding === 'windows-1252'` and answers U+20AC for the byte
  0x80. `decodeLatin1` answers U+0080, because ISO-8859-1 is the identity. The two codings agree
  outside 0x80-0x9F and part company across it.
- **The WHATWG windows-1252 index defines all 256 entries.** It maps each undefined slot to its own
  C1 control, so `TextDecoder('windows-1252')` answers U+0081 for the byte 0x81 where
  `decodeWindows1252` answers `undefined`. Setting `fatal: true` does not change that. The suite
  therefore holds the oracle to the bytes it agrees on and pins those slots directly.
- **A fatal `TextDecoder` strips a leading BOM by default.** `ignoreBOM: true` is what keeps it, and
  this package keeps it always. That is the same divergence stated as the BOM stance, seen from the
  platform's side.

## Membership

A coding belongs here when it is:

- **stateless and spec-named** — a mapping between bytes and text fixed by a published
  specification, carrying no configuration and no instance;
- **single-spelled** — exactly one canonical wire form per input;
- **guard-decidable** — membership in the accepted set is decidable from the value alone, so an
  `is*` can name it;
- **both-lawed** — the round-trip law and the canonical-form law hold as written;
- **wanted** — a real consumer in the fleet needs it now.

The charsets meet that bar in the inverted direction and nothing else changes. Each is fixed by a
published specification, carries no configuration, and spells one canonical byte sequence per text.
Latin-1 is the case worth reading twice: its decoder refuses nothing, so its guard names its encode
side, and the bar is met by the direction that has a set to name rather than by the one that does
not.

A measure belongs here when the coding it measures is already here, the sound-triple law holds as
written in that coding's own direction, and a consumer needs the size before the bytes. It names no
grammar of its own, so it ships beside its coding rather than as a face. `measureBase64`,
`measureBase64URL`, `measureHex`, and `measureUTF8` each meet that bar. UTF-8 is the charset that
meets it, because its width varies per code point and the walk deciding that width is work a
consumer sizing a buffer would otherwise repeat. The other charsets fail the last clause rather than
the first: `encodeLatin1` and `encodeWindows1252` write one byte per code unit and `encodeUTF16LE`
writes two, so `text.length` already answers the question and a measure there would name no walk its
encoder skips.

A transform that carries state between calls, that takes a parameter changing what it produces,
that reads a document grammar rather than a byte-to-text mapping, or that encodes a caller's policy
rather than a specification, is outside the bar. Leniency is a caller's policy in particular: a
consumer that must accept whitespace or unpadded §4 input normalizes its input and then calls the
strict decoder, so the leniency lives with the consumer that owns it rather than in every consumer
of this package.

## Declared non-goals

- **No lenient doors.** No whitespace stripping, no optional padding, no permissive alphabet, no BOM
  discarding, no replacement character, and no option to relax any of it.
- **No error type.** A decoder reports failure as `undefined` and a guard reports it as `false`.
  Nothing here throws, so there is nothing to catch and no code to branch on.
- **Never:** compression, stream framing, document escaping, value-to-store mapping, and JSON.
  Those are other packages' work.

## Patterns

### Encode and decode a byte sequence

```ts
import { decodeBase64, encodeBase64 } from '@orkestrel/codec'

encodeBase64(new Uint8Array([104, 105])) // 'aGk='
decodeBase64('aGk=') // Uint8Array [104, 105]
encodeBase64(new Uint8Array([])) // ''
decodeBase64('') // Uint8Array []
```

### Reach the url face

```ts
import { decodeBase64URL, encodeBase64URL } from '@orkestrel/codec'

encodeBase64URL(new Uint8Array([104, 105])) // 'aGk' — §5 carries no padding
encodeBase64URL(new Uint8Array([0xfb, 0xff, 0xbf])) // '-_-_'
decodeBase64URL('-_-_') // Uint8Array [251, 255, 191]
decodeBase64URL('aGk=') // undefined — padding belongs to §4
decodeBase64URL('+/+/') // undefined — those characters belong to §4
```

### Meet the canonical refusals

```ts
import { decodeBase64, encodeBase64, isBase64 } from '@orkestrel/codec'

decodeBase64('aa==') // undefined — the unused trailing bits are not zero
decodeBase64('aQ==') // Uint8Array [105] — the canonical spelling of that byte
encodeBase64(new Uint8Array([105])) // 'aQ=='
decodeBase64('AQ ID') // undefined — whitespace
decodeBase64('A') // undefined — a length off the group boundary
decodeBase64('AQID=') // undefined — padding off the group boundary
decodeBase64('-_-_') // undefined — the url alphabet
isBase64('aa==') // false
```

### Ask a value whether a decoder would take it

```ts
import { isBase64, isBase64URL } from '@orkestrel/codec'

isBase64('aGk=') // true
isBase64('aGk') // false — §4 requires the padding
isBase64URL('aGk') // true
isBase64URL('aGk=') // false
isBase64URL(42) // false — total on any value, never a throw
```

### Drive both laws

```ts
import { decodeBase64, encodeBase64, isBase64 } from '@orkestrel/codec'

const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
const text = encodeBase64(bytes) // 'AAEC/f7/'

// The round-trip law: decoding an encoding returns the bytes.
decodeBase64(text) // deep-equals bytes

// The canonical-form law: re-encoding an admitted text returns the text.
isBase64(text) // true
const decoded = decodeBase64(text)
if (decoded !== undefined) encodeBase64(decoded) // === text
```

### Read the hex face

```ts
import { decodeHex, encodeHex, isHex } from '@orkestrel/codec'

encodeHex(new Uint8Array([0xab])) // 'ab'
decodeHex('ab') // Uint8Array [171]
decodeHex('AB') // undefined — this package spells the §8 alphabet lowercase
decodeHex('0xab') // undefined — the prefix is notation around the coding
decodeHex('abc') // undefined — a byte takes two digits
isHex('ab') // true
isHex('AB') // false
```

### Encode and decode through a charset

```ts
import {
	decodeLatin1,
	decodeUTF8,
	decodeUTF16LE,
	decodeWindows1252,
	encodeLatin1,
	encodeUTF8,
	encodeUTF16LE,
	encodeWindows1252,
} from '@orkestrel/codec'

// UTF-8 closes on both sides: ill-formed text going out, a non-shortest spelling coming back.
encodeUTF8('hi') // Uint8Array [104, 105]
decodeUTF8(new Uint8Array([104, 105])) // 'hi'
encodeUTF8('\ud800') // undefined — a lone surrogate has no UTF-8 spelling
decodeUTF8(new Uint8Array([0xc0, 0x80])) // undefined — the overlong spelling of U+0000
decodeUTF8(new Uint8Array([0xef, 0xbb, 0xbf])) // '\ufeff' — the BOM is data, not a signal

// ISO-8859-1 is the identity on a byte, so only its encode side can refuse.
encodeLatin1('é') // Uint8Array [233]
decodeLatin1(new Uint8Array([0x80])) // '\u0080' — not the euro sign the latin1 label answers
encodeLatin1('Ā') // undefined — a code unit past 0xFF

// Windows-1252 closes where the code page itself stops.
encodeWindows1252('€') // Uint8Array [128]
decodeWindows1252(new Uint8Array([0x80])) // '€'
decodeWindows1252(new Uint8Array([0x81])) // undefined — an undefined code-page slot

// UTF-16LE closes on an odd length and on a surrogate the byte stream leaves unpaired.
encodeUTF16LE('hi') // Uint8Array [104, 0, 105, 0]
decodeUTF16LE(new Uint8Array([0x68])) // undefined — an odd length completes no code unit
decodeUTF16LE(new Uint8Array([0x00, 0xd8])) // undefined — a lead surrogate with nothing after it
```

### Measure without producing the bytes

```ts
import { measureBase64, measureBase64URL, measureHex, measureUTF8 } from '@orkestrel/codec'

// An RFC 4648 measure reads wire text and answers the byte length its decoder would allocate.
measureBase64('aGk=') // 2
measureBase64('aa==') // undefined — the same texts decodeBase64 refuses
measureBase64URL('aGk') // 2
measureBase64URL('aGk=') // undefined — padding belongs to §4
measureHex('abcd') // 2
measureHex('AB') // undefined — uppercase re-encodes as 'ab'

// UTF-8 inverts the direction: native text in, wire bytes counted.
measureUTF8('hi') // 2
measureUTF8('é') // 2
measureUTF8('€') // 3
measureUTF8('\u{10000}') // 4
measureUTF8('\ud800') // undefined — ill-formed text has no UTF-8 spelling
```

## Tests

- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — every law as a sweep. The
  round-trip law runs the whole octet space in one buffer, every padding residue, every single
  byte, and every byte pair on the §4 and §5 faces; the §8 face runs the same one-buffer sweep and
  residue prefixes beside its empty, single-byte, and byte-pair walks. The canonical-form law runs an
  exhaustive walk over short texts spanning the Base64 alphabets and a second walk over short hex
  texts carrying uppercase and foreign characters, re-encoding every admitted text to itself. The
  sound-triple law runs `measureBase64` against `decodeBase64` and `measureBase64URL` against
  `decodeBase64URL` over the Base64 sweep population and the written-out Base64 membership and
  measure rows, runs `measureHex` against `decodeHex` over the hex sweep population and the
  written-out hex rows, holds every measure against every canonical encoding of an octet prefix, and
  drives all three over a deterministic mutant population — canonical encodings of octet prefixes up
  to 24 bytes, each carried under one substitution, insertion, or truncation from a written-out
  xorshift over a constant seed, so a refusal lands deep inside a text whose prefix is admissible
  where the four-character sweeps cannot reach. `measureUTF8` runs against `encodeUTF8` instead,
  over the well-formed text population, the ill-formed rows, every boundary code point, and its own
  written-out rows. One case reads what the mutants actually reach on each face, so a population
  that admitted everything would fail rather than pass quietly. Beside the sweeps sit the
  written-out membership rows that bind each guard to its
  decoder, the hex rows that pin `isHex` and `decodeHex` to the same answer, the named vectors, the
  named measures on each face, the canonical refusals, the Base64 alphabets read against the
  specification in both directions, the hex alphabet read against the language's own radix
  conversion in both directions, and guard totality against hostile values.

  The charset faces run the same two laws in their own direction. The round-trip law walks a
  well-formed text population built from characters spanning every UTF-8 width threshold, the BOM,
  the Latin-1 ceiling, both Windows-1252 bands, and the code points on either side of the surrogate
  range, and pins each width threshold at the byte length
  the specification fixes. The canonical-form law walks the exhaustive two-byte space on all four
  faces, re-encoding every admitted pair to itself, and reads the Windows-1252 defined mapping as a
  bijection and the Latin-1 mapping as the identity bijection. Beside the sweeps sit the written-out
  refusal rows — the overlongs, the encoded surrogates, the out-of-range and truncated sequences,
  the undefined code-page slots, the odd length, and the unpaired surrogates — each pinned against
  both its decoder and its guard.

  The platform's own codings run as oracles over the populations they agree on, each one probed
  before a sweep was written to it. `decodeUTF8` and `decodeUTF16LE` are held against a fatal
  `TextDecoder` carrying `ignoreBOM` over the whole two-byte space, `encodeUTF8` against
  `TextEncoder` over the well-formed texts, and `decodeWindows1252` against the WHATWG index over
  the bytes that index and this coding both define. `decodeLatin1` is held against
  `String.fromCharCode` rather than against the `latin1` label, and one assertion pins the label's
  disagreement to the 0x80-0x9F band so a later reader cannot quietly adopt it as the oracle.

  Further sweeps reach the multi-byte defects a two-byte space cannot present. The embedded
  sweep wraps every byte pair as `41 b1 b2 41`, which moves each pair into the middle of a buffer
  the decoder has already started walking. The mutation sweep takes the canonical encoding of each
  boundary code point and substitutes every byte position through all 256 values, which reaches the
  overlong spellings of a four-byte code point and the encoded surrogates that sit one lead byte
  from a canonical U+D7FF. Both run against the same fatal `TextDecoder`.

  The Windows-1252 high table carries a second reading that is not a platform decoder at all. The
  WHATWG index defines all 256 slots, so it is silent on exactly the omissions that make this code
  page what it is; a hand transcription of the published table in `tests/setup.ts`, carrying the
  characters rather than their code points, is compared against the source table entry by entry and
  in both key directions. That is what `RFC_STANDARD` does for the Base64 alphabets, and it closes
  the same shared-error class here.

- [`tests/policy.test.ts`](../tests/policy.test.ts) — repository coding law: source placement,
  exports, and syntax.
- [`tests/config.test.ts`](../tests/config.test.ts) — the root configuration's aliases, projects,
  outputs, and the gate each proof runs from.
- [`tests/guides.test.ts`](../tests/guides.test.ts) — this guide against the real surface, in both
  directions, plus the transcribed fences.
- [`tests/distribution.test.ts`](../tests/distribution.test.ts) — the packed package installs and
  resolves through its public exports.

## See also

- [`AGENTS.md`](../AGENTS.md) — the repository rules this package is written to.
- [`guide.md`](guide.md) — the mirrored guide for `@orkestrel/guide`, the devDependency powering the
  guides-parity suite.
- [`scaffold.md`](scaffold.md) — the mirrored guide for `@orkestrel/scaffold`, the devDependency
  that generated this workspace.
- [`README.md`](README.md) — the guides index.
