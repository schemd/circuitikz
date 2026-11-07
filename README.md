# @schemd/circuitikz

Convert a strict subset of [CircuiTikZ](https://ctan.org/pkg/circuitikz) into
[schemd](https://schemd.johnowolabiidogun.dev) source, preserving circuit topology.

> **Status: M0, scaffold.** There is no converter yet. What exists are the contract
> ([REQUIREMENTS.md](./REQUIREMENTS.md)), the public types, the topology oracle the converter will be
> checked against, the conformance corpus, and every quality gate. The milestones are in
> [REQUIREMENTS.md §10](./REQUIREMENTS.md#10-milestones). Nothing is published to npm before 0.1.0.

## What it will do

```tex
\begin{circuitikz}
\draw (0,0) to[battery1] (0,2)
  to[R=100] (2,2)
  to[R=200] (4,2)
  -- (4,0) -- (0,0);
\end{circuitikz}
```

becomes

```text
source:B1 "B1" at (80, 180) #blue [type=battery orientation=down]
resistor:R1 "100" at (180, 80) #amber
resistor:R2 "200" at (380, 80) #amber

B1.negative -> R1.in #blue [ortho]
R1.out -> R2.in #amber [ortho]
R2.out -> B1.positive #amber [ortho]
```

which `@schemd/core` compiles to an SVG. The converter works on the **circuit**, not the picture.
Points where three or more segments meet become junctions. Corners are dropped, because schemd
routes its own wires. A component keeps its polarity: `battery1` puts its positive plate at the
start of its segment.

Anything outside the subset is rejected with a diagnostic at the TeX line and column. Nothing is
approximated, and nothing is dropped without a diagnostic. Before it returns, every successful
conversion is compiled by `@schemd/core`, and its netlist is checked against the TeX's connectivity.

## API (planned for M1 and M2; types already in `src/types.ts`)

```ts
import { convertCircuitikz } from '@schemd/circuitikz';
import { compileSchematic } from '@schemd/core';

const result = convertCircuitikz(tex);
if (result.ok) {
	const { svg } = compileSchematic(result.source, result.fence);
} else {
	for (const d of result.diagnostics) console.error(`${d.line}:${d.column} ${d.message}`);
}
```

Available now: the parser and the topology oracle. `convertCircuitikz` reads the TeX and reports every
problem it finds, but it does not convert yet. For input with no problem, it returns a single
`unsupported` error saying so. Named coordinates, `+`/`++` and `cycle` are resolved as TikZ resolves
them, so an undefined or duplicate name, `cycle` after a `to[...]`, and a relative point that
overflows are reported too.

| Export | What it does |
| --- | --- |
| `convertCircuitikz(tex, options?)` | Parse one `circuitikz` environment and return its diagnostics; `ok` is always `false` until M2 |
| `connectivityOf(netlist)` | Canonical connectivity of a schemd netlist: sorted nets of `ID.port`, with junctions left out |
| `connectivityDifference(expected, actual)` | The first difference between two connectivities, as a sentence, or `undefined` |
| `canonical(nets)` | Sort and deduplicate a connectivity by code unit |

`@schemd/core` is a **peer** dependency. The package has no runtime dependencies of its own.

## Contributing

Read [REQUIREMENTS.md](./REQUIREMENTS.md) first, then [CONTRIBUTING.md](./CONTRIBUTING.md). The
gates are strict, and they are the same ones `@schemd/core` holds itself to:
- 100% coverage on all four axes;
- a mutation gate in which every module carries mutants;
- a fuzz contract;
- byte-exact conformance fixtures;
- a size budget.

```sh
bun install
bun run release:check
```

[Requirements](./REQUIREMENTS.md) · [Contributing](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md) ·
[schemd/core#7](https://github.com/schemd/core/issues/7) · [MIT](./LICENSE)

## Community

[Contributing](./CONTRIBUTING.md) · [Support](./SUPPORT.md) · [Security](./SECURITY.md) ·
[Code of Conduct](./CODE_OF_CONDUCT.md) · [Maintainers](./MAINTAINERS.md)
