# Changelog

Written for someone deciding whether to upgrade. Sections: `Fixed`, `Added`, `Removed`, `Changed`,
`Verified`, `Performance`, `Documented`. Dates are npm publication dates; unpublished versions say
`Unreleased`.

## [0.0.0] - Unreleased

### Added

- The contract, `REQUIREMENTS.md`, and the public types in `src/types.ts`.
- `convertCircuitikz(tex, options?)` parses one `circuitikz` environment and reports every problem
  it finds, with its line and column: unsupported statements, keys and coordinate forms, syntax
  errors, excess decimal precision and resource limits. After a malformed statement it carries on at
  the next `;`. It resolves named coordinates, `+`/`++` and `cycle` as TikZ does, and reports an
  undefined or duplicate name, `cycle` after a `to[...]`, and a relative point that overflows. A name
  built on a point that already failed doesn't repeat that error where it is used. It doesn't convert yet: input with no problem gets one `unsupported` error saying so.
  Options are `title`, `strict` (presentation warnings become errors) and `maxSourceLength`.
- The circuit graph (R-4.4, R-4.5, R-5.1, R-5.2), built after the coordinates resolve with no error.
  Each `to[...]` resolves to one kind (the R-4.4.1 aliases of resistor, capacitor, inductor and
  `battery1`; `short` is a wire) and at most one label. A second kind or label key, an unknown key, a
  label or `invert` on `short`, or a valued `invert` is an error; repeated `invert` stays inverted, and
  `fixbatteries` turns batteries only. Labels keep R-4.5.3's characters, with `_`, `^`, braces, the
  core math commands and `\,` `\;` `\ ` in math only, and read whitespace as TeX does: a comment
  joins the next line with no space (checked against CircuiTikZ with tectonic), and blanks inside math
  are dropped, as TeX drops them. A control word followed by a letter gets `{}` after it, so core
  draws `$\mu F$` as μF instead of printing `\muF`. A label refused for its content is not also
  reported as empty, and a second kind written with a value is one error, not two. Points join only when their integer coordinates are equal;
  `|-` and `-|` are split at their corner. The graph reports a diagonal part, one shorter than 0.84
  units, segments that overlap along their length, an endpoint inside another segment, a wire stub or
  a wire connected to nothing, a circuit with no part or junction, more than 512 junctions, more than
  64 distinct segment directions (a new R-2.5.3 ceiling: the endpoint check costs one lookup per vertex
  and direction), and a drawing larger than core's canvas, stated in TikZ units. An overlap or an
  endpoint inside a segment is reported alone, without the stubs and orphan wires it leaves apart. A
  zero-length wire makes no vertex, so it moves no bound. It also computes, for the emitter to come, the nets, the junctions
  at every vertex of three or more edge ends, and one connection per edge of the contracted wire
  forest, running the way the pen first drew it.
- The topology oracle: `connectivityOf`, `connectivityDifference` and `canonical` compare a schemd
  netlist with the connectivity a CircuiTikZ circuit describes, with junctions left out.
- The conformance corpus. It has four cases: the series circuit from
  [schemd/core#7](https://github.com/schemd/core/issues/7), a divider with two junctions, every
  coordinate form on one path, and a wire that returns to its part's start. Each
  expected document is checked against `@schemd/core` 1.1: no diagnostics, routed on the first pass,
  and wired as the TeX describes.

### Verified

- 100% coverage on all four axes, every mutant killed, a source-policy test, a packaging test,
  62 rejection fixtures that pin each diagnostic's full message and position, and the 5 KiB M1 size
  budget.
- A fuzz contract (`bun run test:fuzz:contract`, run in CI and by `release:check`): 20,000 seeded
  inputs per run, each converted twice in an isolated worker with a 2-second deadline that starts once
  the worker has loaded. Every result must have exactly its five fields, keep its diagnostics and
  source-map spans in order and inside the input, repeat exactly, and contain no `internal`
  diagnostic. A run passes only when its worker reports every case done; a failure before the first
  input is reported as the run's, with no reproducer. A failure is saved as `fuzz-failure-<seed>.json`
  at once, through a temporary file it renames. It is minimized within a budget
  (`--minimize-attempts`, 2,000 by default, and two minutes) only when it fails alone in a fresh worker
  the same way, and only to inputs that fail that way. One that needs the earlier inputs of its seed is
  kept whole and marked `with-prefix`, with a fingerprint of the fixtures and limits that built them.
  `--replay=<file>` reruns a saved failure the way it reproduces, says when it fails differently, and
  refuses a `with-prefix` replay once the fixtures or limits change. Unknown arguments are rejected,
  and CI keeps the file as an artifact.
- The graph is checked without the emitter: against every conformance case (parts, labels, nets,
  junctions and their positions, the fence, and each connection's ends, direction and colour, read
  from the hand-written expected document), against a brute-force model on 3,000 seeded random
  circuits (nets, junctions and every graph diagnostic, plus a spanning forest of connections over
  each net), and by boundary matrices: every pair of label keys and of kinds, invert × fixbatteries,
  every printable ASCII character in text and math labels, each overlap relation on four line
  directions, 0.83 and 0.84 units in each direction, and the canvas limit and one hundredth past it.
- A smoke test of the built package (`bun run test:smoke`, which builds first; run in CI and by
  `release:check`, R-8.6.2). It runs under Node.js 24+ only, not Bun. Every `src` module, nested ones
  included, must have non-empty built code and declarations, and every built module must load. The
  entry must export exactly the public API, and its declarations must name every export and public
  type. In Node.js the built converter answers a supported circuit with the pending diagnostic, and
  the topology helpers are checked against connectivity worked out by the script itself, never by
  another helper. The entry is then bundled as one script and run in fresh V8 contexts with the Web
  globals every host shares and none of Node.js's own (`process`, `Buffer`, `require`, `global`,
  `setImmediate`): bare, as a worker (`self`) and as a page (`window`). In each, every fixture input
  and every export must answer as in Node.js (the browser half of R-2.2.2). The bundle may import
  only `@schemd/core` and its own files: Vite would otherwise swap a Node.js module for an empty one,
  or inline a package that is only installed for the repository's tools. It replaces the one-line CI
  import of `dist/index.js`.
