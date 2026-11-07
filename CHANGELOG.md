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
- The topology oracle: `connectivityOf`, `connectivityDifference` and `canonical` compare a schemd
  netlist with the connectivity a CircuiTikZ circuit describes, with junctions left out.
- The conformance corpus. It has two cases: the series circuit from
  [schemd/core#7](https://github.com/schemd/core/issues/7), and a divider with two junctions. Each
  expected document is checked against `@schemd/core` 1.1: no diagnostics, routed on the first pass,
  and wired as the TeX describes.

### Verified

- 100% coverage on all four axes, every mutant killed, a source-policy test, a packaging test,
  33 rejection fixtures that pin each diagnostic's full message and position, and the 5 KiB M1 size
  budget.
