# Requirements — `@schemd/circuitikz`

This file is the contract. Every pull request is reviewed against it. A change to the contract
itself is a pull request to this file, reviewed by the maintainer before any code assumes it.

The words **MUST**, **MUST NOT**, **SHOULD** and **MAY** are used as in RFC 2119. Each requirement
has a stable ID (`R-…`). Cite the IDs a pull request satisfies in its description, and cite the
test that proves each one.

Origin: [schemd/core#7](https://github.com/schemd/core/issues/7).

---

## 1. Purpose

**R-1.1** The package converts a **strict, documented subset** of CircuiTikZ into
[schemd](https://schemd.johnowolabiidogun.dev) source that `@schemd/core` compiles.

**R-1.2** The guarantee is **topology**, not appearance. A successful conversion ties together exactly
the terminals the TeX ties together, with the same component kinds, polarities and labels. The
drawing MAY differ: schemd places parts at fixed sizes and routes its own wires.

**R-1.3** Anything outside the subset is **rejected with a diagnostic** that points at the TeX line
and column. A best-effort conversion that quietly drops or approximates a construct is a defect.

### 1.1 Non-goals

These will not be merged. Open an issue first if you think one should change.

- A TeX engine, a macro expander, or a general TikZ parser. `\def`, `\newcommand`, `\foreach`,
  `\pgfmathsetmacro`, styles defined with `\tikzset`/`\ctikzset`, and user macros are rejected.
- Pixel or layout fidelity with the CircuiTikZ rendering.
- Conversion in the other direction (schemd → CircuiTikZ).
- Electrical analysis of any kind.
- Reading a whole LaTeX document. Input is one `circuitikz` environment (R-4.1).

---

## 2. Invariants

These hold for every commit on `main`.

### 2.1 Dependencies

**R-2.1.1** `package.json` has no `dependencies`, `optionalDependencies` or `bundleDependencies`.
`@schemd/core` is the single `peerDependency`, with the same range as its `devDependency`.
*Enforced by `tests/packaging.test.ts`.*

**R-2.1.2** `src` imports `@schemd/core` only through its package entry (`from '@schemd/core'`),
never through a subpath or `dist` file. *Enforced by `tests/source-policy.test.ts`.*

**R-2.1.3** A new devDependency needs a sentence in the pull request saying why the existing
toolchain cannot do the job.

### 2.2 Purity

**R-2.2.1** `convertCircuitikz` is a pure function of its arguments. It performs no I/O, reads no
environment, keeps no state between calls and mutates none of its inputs.

**R-2.2.2** `src` uses no Node.js API, no DOM, no `console`, no `eval`/`new Function`, and no
`new RegExp`. It runs unchanged in Node.js 24+, a browser, and a web worker. *Enforced by
`tests/source-policy.test.ts`; the browser half by R-8.6.*

### 2.3 Determinism

**R-2.3.1** The same input and options give byte-identical output — source, fence, diagnostics, source
map — on every run and platform.

**R-2.3.2** No clock, no randomness, and no locale: no `Math.random`, `Date`, `performance.now`,
`localeCompare`, `toLocale*` or `Intl`. Sorting compares code units. *Enforced by
`tests/source-policy.test.ts`.*

**R-2.3.3** Every tie is broken on something in the document — position in the TeX source first —
and each tie-break is pinned by a test.

**R-2.3.4** Coordinates are integers from the moment they are parsed (R-4.3.1) to the moment they
are written (R-5.3.4). No float is ever formatted.

### 2.4 Types

**R-2.4.1** TypeScript in the strict configuration in `tsconfig.json` (copied from `@schemd/core`):
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`,
`noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`. `bun run check` passes.

**R-2.4.2** No `any`, no `@ts-ignore`, `@ts-nocheck` or `@ts-expect-error` in `src`. *Enforced by
`tests/source-policy.test.ts`.*

**R-2.4.3** Relative imports end in `.js`, so the built package resolves under Node.js. *Enforced.*

### 2.5 Safety on hostile input

**R-2.5.1** For **any** string input and valid options, `convertCircuitikz` returns a
`CircuitikzConversion`. It never throws, never hangs, and never recurses without a bound. It throws
`TypeError` for exactly two programming errors in the host: a non-string first argument, and invalid
options (R-3.6).

**R-2.5.2** Running time is linear in input length, up to logarithmic factors. The lexer is
hand-written and scans each character a bounded number of times. No regular expression runs over
unbounded input. *Proved by the fuzz contract (R-8.3) and the pathological inputs in R-8.3.4.*

**R-2.5.3** Every resource has a ceiling with a diagnostic (`limit`), checked before the work it
bounds: source length, statements, path elements per statement, components, junctions, and brace
nesting depth. The defaults are constants in one module, each with a test at the ceiling and one past
it.

---

## 3. Public API

The exact types are in `src/types.ts`; this section is their meaning. Changing either needs the
maintainer's review (`.github/CODEOWNERS`).

```ts
import { convertCircuitikz } from '@schemd/circuitikz';

const result = convertCircuitikz(tex, { title: 'Series circuit' });
if (result.ok) {
	compileSchematic(result.source, result.fence); // never throws for an ok result
}
```

**R-3.1** `convertCircuitikz(source: string, options?: ConvertCircuitikzOptions): CircuitikzConversion`
is the package's only conversion entry point.

**R-3.2** `ok` is `true` exactly when `diagnostics` holds no `error`. When `ok` is `false`,
`source` and `fence` are `undefined` and `sourceMap` is empty. **There is no partial output.**

**R-3.3** When `ok` is `true`:
- `diagnoseSchematic(source, fence)` returns `[]`;
- `compileSchematic(source, fence)` does not throw;
- the connectivity of the compiled netlist equals the connectivity of the TeX (R-6).

The converter checks all three before returning (R-6.3). A failure is an `internal` diagnostic, never
an `ok` result.

**R-3.4** `diagnostics` lists **every** problem the converter can find in one call, errors and
warnings, sorted by `(line, column)` with ties kept in phase order. A document with five unsupported
constructs gets five diagnostics, not one.

**R-3.5** `sourceMap` has exactly one entry for each non-blank line of `source`, in order. Each entry
points at the TeX span the line came from: a component at its `to[...]` operation, a junction at the
coordinate where its segments meet, a connection at the path operation that made it.

**R-3.6** Options are validated. An unknown key, a value of the wrong type, or a value out of range
**throws** `TypeError` naming the key and the accepted values, because a misspelt option is a
programming error in the host, not a problem in the TeX. The option set:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `title` | non-empty string, ≤ 120 code units | `'Converted CircuiTikZ circuit'` | The fence title |
| `strict` | boolean | `false` | Every warning becomes an error |
| `maxSourceLength` | integer 1 … 1,000,000 | `100_000` | Longest TeX input accepted |

**R-3.7** The package also exports the topology oracle (`connectivityOf`, `connectivityDifference`,
`canonical`) so that a host can check any converted document itself.

**R-3.8** Every public export has a doc comment, is listed in the README, and has a changelog entry
in the release that introduced it.

---

## 4. Input language

### 4.1 Document

**R-4.1.1** The input is exactly one `\begin{circuitikz}` … `\end{circuitikz}` environment.
Whitespace and `%` comments MAY surround it. Any other text outside it is an `unsupported` error
whose message says to pass a single environment.

**R-4.1.2** Environment options in `[...]`: presentation-only keys (R-5.4) give a warning, and
`fixbatteries` is honoured (R-4.4.3). Every other key is `unsupported`.

**R-4.1.3** `%` starts a comment to the end of the line, except when it is escaped as `\%`. Comments
never reach the output.

**R-4.1.4** Lines end at `\n`, `\r\n` or `\r`. Columns count UTF-16 code units, one-based, as
`@schemd/core` counts. A tab is one column.

### 4.2 Statements

**R-4.2.1** Supported statements:
- `\draw[options] path ;`
- `\coordinate (name) at (x,y);`

A statement ends at its `;`. A missing `;` is a `syntax` error at the end of the statement's last
token.

**R-4.2.2** Every other control sequence at statement level is `unsupported`, and the diagnostic
names it. That includes `\node`, `\path`, `\fill`, `\filldraw`, `\foreach`, `\def`, `\newcommand`,
`\tikzset`, `\ctikzset`, `\begin{scope}` and `\pgf…`.

**R-4.2.3** **Error recovery**: after an error inside a statement, the parser skips to the next `;`
at brace depth 0, or to `\end{circuitikz}`, and continues. One malformed statement never hides a
problem in another. A `\draw` or `\coordinate` met while skipping also ends the skip, so a missing
`;` does not swallow the statement after it ([#2](https://github.com/schemd/circuitikz/issues/2) §8).

### 4.3 Paths

**R-4.3.1** Coordinates:

| Form | Meaning | Milestone |
| --- | --- | --- |
| `(x,y)` | Absolute, in TikZ units (1 unit = 1 cm by default) | M2 |
| `(xcm,ycm)` | The same, with an explicit `cm` | M2 |
| `++(dx,dy)` | Relative to the current point, and moves it | M2 |
| `+(dx,dy)` | Relative to the current point, and leaves it where it was | M2 |
| `(name)` | A named coordinate defined earlier | M2 |
| `coordinate (name)` inside a path | Names the current point | M2 |
| `cycle` after wires only | The start of the current subpath: the last move-to (#2 §7) | M2 |
| `cycle` after a `to[...]` in the same subpath, `to[short]` included | — | `unsupported`; the message asks for an explicit end coordinate (#2 §7) |
| `(a,b)` with units other than none or `cm`, polar `(30:2)`, `(A.north)`, `(A \|- B)`, `($…$)` | — | `unsupported` |

Numbers are decimal: optional sign, digits, optional fraction, no exponent. They are parsed
**exactly**, digit by digit, into integers of 1/100 TikZ unit, which is one schemd unit (R-5.3.1).
A number with more than two decimal places is a `syntax` error that says so, rather than being
rounded.

**R-4.3.2** Operations: `--`, `|-`, `-|` and `to[...]`. `|-` and `-|` go through their corner
point, and the corner is a point of the path graph (R-5.1). Every other operation (`..`, `rectangle`,
`circle`, `arc`, `grid`, `node`, `pic`, `edge`, `to` without `[...]`) is `unsupported`.

**R-4.3.3** A named coordinate used before its definition, or never defined, is a `reference` error.
A name defined twice is a `reference` error at the second definition.

**R-4.3.4** `+(…)` and `++(…)` follow TikZ: both are relative to the last point that set the
reference, and the path goes to both. `++` moves the reference to the new point and `+` leaves it
where it was, so `(0,0) -- +(1,0) -- +(0,1)` draws (0,0) to (1,0) to (0,1). Each form has a fixture.

### 4.4 Components

**R-4.4.1** A component is `to[NAME]`, `to[NAME=label]`, or `to[NAME, key=value, …]`. Recognised
names map to schemd as follows. Before a row is implemented, the pull request MUST cite the
CircuiTikZ source (file and shape) that fixes which end of the path is which terminal. The row's
fixture pins it.

| CircuiTikZ names | schemd | Terminal at the path's start → end | Milestone |
| --- | --- | --- | --- |
| `R`, `resistor`, `american resistor`, `european resistor` | `resistor` | `in` → `out` | M2 |
| `C`, `capacitor` | `capacitor` | `in` → `out` | M2 |
| `L`, `inductor`, `american inductor`, `cute inductor`, `european inductor` | `inductor` | `in` → `out` | M2 |
| `battery1` | `source [type=battery]` | `positive` → `negative` (see R-4.4.3) | M2 |
| `battery`, `battery2` | `source [type=battery]` | to be established from the source, per row | M3 |
| `D`, `diode`, `empty diode`, `full diode` | `diode` | `anode` → `cathode` | M3 |
| `zD`, `leD` | `diode [type=zener]`, `diode [type=led]` | `anode` → `cathode` | M3 |
| `nos`, `ospst` | `switch [type=spst]` | `in` → `out` | M3 |
| `ncs`, `cspst` | — | — | `unsupported` until `@schemd/core` draws a closed switch (#2 §4) |
| `short` | a wire | — | M2 |
| `node[ground]{}` at a point | `ground` | `in` at the point | M3 |

Every other name, including `open`, `V`, `I`, `vsource`, `isource`, sources with a voltage
direction, transistors and op-amps, is `unsupported`. A future milestone that adds a source MUST
first settle CircuiTikZ's voltage-direction conventions (`voltage dir`, `EFvoltages`,
`RPvoltages`) in a design issue.

**R-4.4.2** Keys inside `to[...]`:

| Key | Treatment |
| --- | --- |
| `NAME=text`, `l=text` | The label (R-5.3.2) |
| `invert` | Swaps the terminals; pinned by a fixture per polar kind |
| `l_=`, `l^=`, `a=`, `a_=`, `a^=` | Presentation: a warning (R-5.4), label taken where applicable |
| `-*`, `*-`, `*-*`, `-o`, `o-`, `o-o` and the other pole shapes | Presentation: a warning |
| `mirror`, `color=`, `line width=`, `thick`, `thin`, `dashed` | Presentation: a warning |
| `v`, `v_`, `v^`, `v<`, `v>`, `i`, `i_`, `i^`, `i<`, `i>`, `f`, `name`, `n` and any other key | `unsupported` |

**R-4.4.3** `battery1` draws its long, positive plate at the **start** of its segment unless the
environment sets `fixbatteries`, which moves it to the end (circuitikz `tex/pgfcircbipoles.tex`,
shape "Battery 1"). `invert` swaps it again. All four combinations have fixtures.

`@schemd/core` 1.1 draws its battery glyph with the long plate on the `negative` terminal's side, so
a correct conversion is drawn mirrored until core fixes the glyph. The converter keeps the semantic
ports and never swaps terminals to make the picture match: R-6 checks connectivity, and the drawing is
core's to fix (#2 §3).

**R-4.4.4** A component on a segment that is neither horizontal nor vertical is a `geometry` error
that gives both endpoints. A component on a zero-length segment is a `geometry` error. A component
whose segment is too short for the schemd part, at the scale in R-5.3.1, is a `geometry` error that
gives the shortest length that fits.

**R-4.4.5** Option lists (#2 §8):
- A second kind or a second label in one list (`to[R, C]`, `to[R=1, l=2]`) is a `syntax` error at
  the second key. There is no precedence rule.
- `invert` written more than once is the same as written once. CircuiTikZ's key sets a flag; it
  does not toggle.
- Empty entries (`[]`, `[R,]`, `[,thick]`) are ignored, as pgfkeys ignores them.

### 4.5 Labels

**R-4.5.1** A label is transcribed and never embellished: `R=100` labels the part `100`, not
`100 Ω`.

**R-4.5.2** `$…$` content converts to schemd's math-label subset. That covers subscripts and
superscripts with or without braces, `\Omega`, `\mu`, the Greek letters schemd supports, `\,`,
`\;` and `\ `. Any other control sequence in a label is an `unsupported` error naming it. The
converter never passes through a sequence that schemd would print literally.

**R-4.5.3** Text-mode labels may contain letters, digits, spaces and `. , - + / ( ) : '`. Any other
character, `{`/`}` grouping included, is an `unsupported` error naming the character.

**R-4.5.4** A part with no label is labelled with its schemd ID (R-5.3.3), so the ID is drawn twice.
Once `@schemd/core` 1.2.0 is published with optional labels
([schemd/core#9](https://github.com/schemd/core/pull/9)), the peer range moves to `^1.2.0` and a part
with no label is emitted with no label, so only its designator is drawn (#2 §2).

---

## 5. Conversion semantics

### 5.1 The circuit graph

**R-5.1.1** The converter builds a graph:
- **vertices** are the distinct points of all paths, after coordinates are resolved exactly;
- **edges** are path segments, each either a **wire** (`--`, `|-`/`-|` legs, `to[short]`) or a
  **component** (`to[NAME]`).

A component's two terminals are its two endpoints.

**R-5.1.2** Two points are the same vertex exactly when their resolved integer coordinates are
equal. There is no tolerance.

**R-5.1.3** **Nets** are the connected components of the graph's wire edges. Every component
terminal lies on exactly one net. A terminal that nothing reaches is a net of its own, on both sides
of the oracle (R-6.2), so an open terminal is compared and never dropped (#2 §1).

**R-5.1.4** A **junction** is emitted at each vertex where three or more edge ends meet. A vertex
with two edge ends is a corner, or two components meeting directly, and emits nothing. schemd's
router draws its bends.

**R-5.1.5** Wire edges that form a cycle add no connectivity. A spanning forest is kept, and the
edge declared last on each cycle is dropped. Connectivity is unchanged, so this gives no diagnostic,
and a test pins it.

**R-5.1.6** A wire that touches no component terminal and no junction is an `unsupported` error
("a wire connected to nothing"). So is a wire chain that ends at a vertex with a single edge end, a
stub hanging off a terminal, because a schemd connection runs from terminal to terminal and the stub
would vanish. Dead ends are found on the graph before R-5.1.5 drops any cycle edge, so a dropped
edge never creates one (#2 §6).

**R-5.1.7** Two segments that overlap along their length, rather than meeting at a vertex, are a
`geometry` error. CircuiTikZ draws them on top of each other, and the intended connectivity is
ambiguous.

**R-5.1.8** A segment endpoint that lies inside another segment, and is not one of its vertices, is a
`geometry` error. CircuiTikZ draws a T there, but R-5.1.2 joins only equal points, so the converter
would otherwise leave the part unconnected. The message tells the author to split the segment at that
point, which makes a real vertex and, by R-5.1.4, a junction. The converter never splits it itself,
because that would create a connection from geometry (#2 §5).

### 5.2 Connections

**R-5.2.1** After corners are contracted (R-5.1.4), every remaining edge between two of {component
terminal, junction} becomes one schemd connection.

**R-5.2.2** A connection runs in the direction the pen first travelled along it: from the end the
TeX path reached first to the end it reached second. Two components that meet directly connect in
path order.

**R-5.2.3** Every connection is `[ortho]`.

### 5.3 Emission

**R-5.3.1** **Scale.** One TikZ unit is 100 schemd units. The y-axis is flipped: TikZ's y grows
upward and schemd's grows downward. The drawing is translated so that its leftmost and topmost
points sit 80 units from the canvas edge. The fence bounds are the extent plus 80 units on each side.
These constants live in one module. Changing them is a contract change.

**R-5.3.2** **Placement.** A component sits at its segment's midpoint, oriented along the segment
from its start terminal to its end terminal. A junction sits at its vertex.

**R-5.3.3** **IDs.** These are assigned in order of first appearance in the TeX. The prefix is per
kind: `R`, `C`, `L`, `B` (battery), `D`, `S` (switch), `G` (ground) and `J` (junction). Each prefix
counts from 1. An ID never depends on anything later in the file.

**R-5.3.4** **Numbers.** Every emitted coordinate is an integer. Positions are exact, because
R-4.3.1 parses to schemd units. A component's midpoint is `Math.floor((a + b) / 2)` of its two
integer endpoints on each axis, after the y flip. That is the one place a half unit can arise, and a
test pins the direction it goes.

**R-5.3.5** **Colours.** These are fixed per kind: resistor `#amber`, capacitor `#cyan`, inductor
`#purple`, battery `#blue`, diode `#rose`, switch `#emerald`, ground and junction `#slate`. A
connection takes the colour of the part it starts from.

**R-5.3.6** **Layout of the document.** Components appear in order of first appearance, then
junctions in ID order, then one blank line, then connections in the order R-5.2.2 produces them. The document ends in
exactly one `\n`, and there is no trailing whitespace on any line.

### 5.4 Presentation-only keys

**R-5.4.1** The keys listed as presentation in R-4.1.2 and R-4.4.2 change only how CircuiTikZ
draws, never what connects to what. The converter ignores them and emits a `warning` for each one,
saying it was ignored and that schemd draws its own style. No other construct can produce a
warning.

**R-5.4.2** With `strict: true`, every such warning is an `error` instead.

**R-5.4.3** The list grows only by a pull request to this file, and each addition says why the key
cannot change topology.

---

## 6. Correctness oracle

**R-6.1** **Intended connectivity** is computed from the circuit graph (R-5.1) alone, before any
schemd text exists. It uses the same canonical form as `connectivityOf`.

**R-6.2** **Emitted connectivity** is `connectivityOf(buildNetlist(compileSchematic(source, fence).document))`.
`buildNetlist` builds nets only from connections, so `connectivityOf` completes them from each node's
port inventory: every port of a non-junction part that is on no net becomes a net of its own (R-5.1.3).
This changes the M0 behaviour of an exported function and needs a `Changed` entry (#2 §1).

**R-6.3** Before returning an `ok` result, the converter runs `diagnoseSchematic` and compiles the
document, then compares the two connectivities with `connectivityDifference`. Any diagnostic, throw
or difference turns the result into a single `internal` error. Its message carries what core said
or the difference, and asks the reader to report it with the input. It points at the
`\begin{circuitikz}` line.

**R-6.4** An `internal` diagnostic is always a bug. Each one found becomes a fixture before it is
fixed.

---

## 7. Diagnostics

### 7.1 House style

**R-7.1.1** Every diagnostic has a `code`, a `severity`, a one-sentence `message`, and a `line`,
`column` and `endColumn` that underline the exact construct: the key, the name, the coordinate.
Never the whole statement when a narrower span exists.

**R-7.1.2** A message says **how to fix the TeX**, not only what is wrong with it. It:
- names the construct as the author typed it;
- says what the converter accepts instead, or that it cannot be converted;
- gives a value that works when one exists ("use `(2,0)` or `(2,1)`; components must be horizontal
  or vertical");
- never mentions converter internals.

**R-7.1.3** Each distinct message has at least one test that asserts the **full message and span**,
not a substring.

**R-7.1.4** Messages are built in one module, one function per message. No message text is
written inline in the parser or emitter.

### 7.2 Conformance corpus

**R-7.2.1** `tests/fixtures/conformance/<case>/` holds `input.tex`, the byte-exact
`expected.schemd`, and `meta.json` with the case's fence, origin, note and intended connectivity.
`tests/conformance.test.ts` checks that every expected document is accepted by `@schemd/core`
without a diagnostic, routes on its first pass (`routing.attempts === 0`), and has the declared
connectivity.

**R-7.2.2** From M2 on, the suite also asserts that `convertCircuitikz(input)` is `ok`, emits
`expected.schemd` byte for byte, and emits the fence in `meta.json`.

**R-7.2.3** `tests/fixtures/rejections/<case>/` holds `input.tex` and `expected.json`, which lists
the exact diagnostics. Every diagnostic message has at least one rejection case.

**R-7.2.4** Every component row in R-4.4.1, every coordinate form in R-4.3.1, and every operation in
R-4.3.2 has at least one conformance case.

**R-7.2.5** A fixture's `expected.schemd` is written by hand, or by the converter and then read
line by line. A pull request that regenerates fixtures in bulk says so, and explains each change.

---

## 8. Quality gates

Every gate runs in CI on every pull request. A red gate blocks the merge.

### 8.1 Coverage

**R-8.1.1** **100%** statements, branches, functions and lines over `src`, enforced by
`vitest.config.ts` thresholds.

**R-8.1.2** No coverage-ignore comments of any kind. *Enforced by `tests/source-policy.test.ts`.*
If a line cannot be reached by any input, delete it.

**R-8.1.3** Coverage is a floor. A test that executes a line without asserting what it does
protects nothing, and review rejects it.

**R-8.1.4** No skipped, focused, deferred or expected-to-fail tests. *Enforced.*

### 8.2 Mutation

**R-8.2.1** `scripts/mutation.mjs` lists named mutants. Each one is a substitution that breaks one
stated property, together with the suites that must fail. A surviving mutant fails CI.

**R-8.2.2** Every module in `src` has at least one mutant, except logic-free modules listed in
`EXEMPT`. *Enforced by the script.*

**R-8.2.3** Every load-bearing rule of this document has a mutant before its milestone closes. That
includes junction degree, pen direction, polarity and `invert`, the y flip, ID order, error recovery,
each resource limit, and the oracle's comparison.

### 8.3 Fuzz contract

From M1 on, `scripts/fuzz.mjs` runs in CI.

**R-8.3.1** It generates seeded random inputs: random characters, random token sequences from the
supported grammar, and mutations of the corpus inputs. The seed is printed.

**R-8.3.2** For every input it asserts:
- the call returns, within R-2.5.2's bound;
- the result has the declared shape;
- every diagnostic's span lies inside the input;
- two calls give identical results;
- an `ok` result satisfies R-3.3.

**R-8.3.3** CI runs at least 20,000 inputs. A failure writes `fuzz-failure-<seed>.json` with the
minimal input. That input becomes a fixture in the pull request that fixes it.

**R-8.3.4** Fixed pathological inputs run in the ordinary suite under a time limit: 100,000 `(`;
100,000 nested `{`; a 1 MB comment; a 1 MB label; 10,000 statements; an unterminated environment.

### 8.4 Properties

From M2 on, property tests assert:

**R-8.4.1** Translating every coordinate in the TeX by the same integer offset gives the same output.

**R-8.4.2** Reordering independent `\draw` statements gives the same intended connectivity.

**R-8.4.3** Reversing a wire path (`(a) -- (b) -- (c)` into `(c) -- (b) -- (a)`) gives the same
connectivity.

**R-8.4.4** For each polar kind, `invert` swaps exactly that part's two terminals in the
connectivity.

### 8.5 Size

**R-8.5.1** `bun run size` gates the gzip and brotli-11 size of the full public entry, with
`@schemd/core` external.

**R-8.5.2** A budget is raised only in the pull request whose code needs the bytes, with a comment
in `scripts/check-bundle-size.mjs` saying what was added and how many bytes it measured.

**R-8.5.3** The 0.1.0 release fits in **12 KiB gzip**.

**R-8.5.4** The milestone budgets, each raised by the pull request that needs it (#2 §9):

| Milestone | gzip | brotli-11 |
| --- | --- | --- |
| M1 | 5 KiB | 5 KiB |
| M2 | 9 KiB | 9 KiB |
| M3 | 9.5 KiB | 9 KiB |

### 8.6 Packaging and runtime

**R-8.6.1** `tests/packaging.test.ts` holds. Every `src` module, nested ones included, is either
an `exports` subpath or listed as internal. `src/index.ts` is the `.` entry, and a nested
`src/<dir>/index.ts` is the `./<dir>` subpath.

**R-8.6.2** CI builds the package, runs `npm pack --dry-run`, and imports the built `dist/index.js`
in Node.js 24 as a smoke test. From M2 on, the smoke test converts the issue example from the built
files.

---

## 9. Process

**R-9.1** All changes arrive as pull requests from forks. Nobody pushes to `main`, the maintainer
included. A merge needs CI green and the maintainer's approval.

**R-9.2** One concern per pull request. A milestone is several pull requests. The description
says:
- which `R-` IDs it satisfies;
- which tests and mutants prove each one;
- what it deliberately does not do;
- the size change.

**R-9.3** A design question is settled in an issue before code assumes the answer. That includes a
new component row, a new key, a change to emission, or a change to this file.

**R-9.4** `CHANGELOG.md` gets an entry for every behaviour change, written for someone deciding
whether to upgrade. It states what a user could observe, not the patch.

**R-9.5** Commit messages are prose, lower-case, present tense, and describe the effect.

**R-9.6** Releases are maintainer-only: a `v*` tag on `main` whose version matches `package.json`
and has a changelog section. CI publishes to npm with provenance through trusted publishing.

---

## 10. Milestones

Each milestone closes when its acceptance list is green on `main`.

### M0 — Scaffold *(this commit)*

- [x] Package, strict TypeScript, CI, size, coverage and mutation gates
- [x] Public types (`src/types.ts`)
- [x] Topology oracle (`src/topology.ts`) at 100% coverage with 10 mutants
- [x] Conformance corpus format, with the issue example and a two-junction case
- [x] Source-policy and packaging tests

### M1 — Lexer and parser, diagnostics only

- [ ] Hand-written lexer with exact spans (R-2.5.2, R-4.1.3, R-4.1.4)
- [ ] Parser for R-4.1 to R-4.3, building a syntax tree with spans; R-4.2.3 recovery
- [ ] Exact decimal parsing (R-4.3.1)
- [ ] Every `unsupported`, `syntax`, `reference` and `limit` diagnostic, with rejection fixtures
  (R-7.2.3)
- [ ] Resource limits (R-2.5.3)
- [ ] Fuzz contract in CI (R-8.3); pathological inputs (R-8.3.4)
- [ ] `convertCircuitikz` exported. Until M2 it returns the diagnostics and, for input with none, a
  single `unsupported` error saying conversion is not implemented yet. This line is removed by M2.

### M2 — Conversion, two-terminal passives and `battery1`

- [ ] Circuit graph, nets, junctions, pen direction (R-5.1, R-5.2)
- [ ] Emission (R-5.3) for the M2 rows of R-4.4.1, labels (R-4.5), presentation warnings (R-5.4)
- [ ] The oracle wired in (R-6)
- [ ] R-7.2.2 enforced; both existing fixtures pass byte-exact
- [ ] Property tests (R-8.4); smoke test of the issue example from `dist` (R-8.6.2)

### M3 — The rest of the initial subset

- [ ] `battery`, `battery2`, diodes, switches, ground: each row with its source citation and
  fixture
- [ ] `invert` on every polar kind

### M4 — 0.1.0

- [ ] Size under R-8.5.3
- [ ] README complete: supported subset, every diagnostic, a worked example
- [ ] A docs page on the schemd website
- [ ] Tagged and published

---

## 11. Open questions

Each one is settled in an issue before the milestone that needs it.

1. ~~**Unlabelled parts.**~~ Settled in #2 §2: `@schemd/core` 1.2.0 accepts an unlabelled
   declaration (R-4.5.4).
2. **`name=`/`n=` as IDs.** CircuiTikZ lets an author name a component. Using that name as the schemd
   ID would be friendlier, but it creates collisions with R-5.3.3. Rejected until settled.
3. **Document extraction.** Educational material is usually whole `.tex` files. A separate
   `extractCircuitikz(document)` returning each environment's span MAY come after 0.1.0. It is not
   part of `convertCircuitikz`.
