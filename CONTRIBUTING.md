# Contributing to `@schemd/circuitikz`

Thank you for considering it. [REQUIREMENTS.md](./REQUIREMENTS.md) is the contract, and every pull
request is measured against it. This file covers how to work within it.

## Setup

You need Node 24 or newer and Bun.

```sh
bun install
bun run release:check   # what CI runs; it should pass on a fresh clone
```

If `release:check` fails on a fresh clone, open an issue. That is a bug.

## The loop

```sh
bun run check            # tsc --noEmit, tests included
bun run test             # every suite
bun run test -- topology # one suite while iterating
bun run test:coverage    # 100% on all four axes, or it fails
bun run test:mutation    # every mutant must die
bun run size             # after anything that could move bytes
```

## The gates

| Command | Protects | Requirement |
| --- | --- | --- |
| `bun run check` | Types across the repo, tests included | R-2.4 |
| `bun run test:coverage` | 100% statements, branches, functions and lines | R-8.1 |
| `bun run test:mutation` | Named mutants, all killed; every module guarded | R-8.2 |
| `tests/source-policy.test.ts` | No ignores, `any`, clocks, locale, I/O or skipped tests | R-2, R-8.1 |
| `tests/packaging.test.ts` | Exports map and dependency contract | R-2.1, R-8.6 |
| `tests/conformance.test.ts` | Every expected document compiles, routes first time, and wires as the TeX does | R-7.2 |
| `bun run size` | gzip and brotli-11 budgets | R-8.5 |
| `bun run test:fuzz:contract` | Never throws, never hangs, spans in bounds, deterministic | R-8.3 |

### Coverage is a floor

100% means every line ran, not that anything was checked. Write the assertion that would fail if the
behaviour inverted. If you are adding a test only to reach a line, ask whether the line should exist.
The M0 scaffold deleted a union-find for exactly this reason: `buildNetlist` already merges
everything wired to a junction, so no input could reach the union-find's merge branch.

### Mutants

Each mutant in `scripts/mutation.mjs` is a precise substitution, named for the property it breaks:

```js
{
	name: 'junction terminals are left out of the circuit',
	file: 'src/topology.ts',
	from: 'net.terminals.filter((terminal) => !junctions.has(terminal.componentId))',
	to: 'net.terminals.filter(() => true)',
	tests: ['tests/topology.test.ts', 'tests/conformance.test.ts']
}
```

A new module arrives with mutants; the script refuses to run otherwise. If a mutant survives, find an
input that tells the two versions apart and keep it as a test. If no input can, the mutant is
equivalent: remove it and say why.

## Fixtures

A conformance case is a directory under `tests/fixtures/conformance/` holding:
- `input.tex`;
- the byte-exact `expected.schemd`;
- `meta.json`, with the fence, where the case came from, a note on anything non-obvious it pins, and
  the connectivity the TeX describes.

Write `expected.schemd` by hand, or read every line the converter emits before you commit it. A
fixture regenerated without being read pins whatever the code happens to do.

**Polarity is the easy thing to get wrong.** Before adding a component row, find the shape in the
CircuiTikZ source (`tex/pgfcircbipoles.tex` and friends) and cite the file and shape in the pull
request. `battery1`, for instance, draws its long plate at the start of its segment unless
`fixbatteries` is set. A guess from a rendered picture is not a citation.

## Diagnostics

A diagnostic says **how to fix the TeX**, not only what is wrong with it:

```
weak:    Unsupported construct.
strong:  \node is not supported; draw ground with (x,y) node[ground]{} on a \draw path, or remove it.
```

The strong version names the construct as typed, says what works instead, and underlines exactly the
construct. Every message is built in one module, and each one has a test asserting the full text and
span (R-7.1).

## Pull requests

- **Work from a fork.** Nobody pushes to `main`.
- **One concern each.** A milestone is several pull requests.
- **Settle design in an issue first:** a new component, key, emission rule, or change to
  REQUIREMENTS.md.
- **Fill in the template:** the `R-` IDs satisfied, the tests and mutants that prove them, what you
  deliberately did not do, and the size change.
- **Behaviour changes need a changelog entry.** Write it for a user deciding whether to upgrade.
- **Commit messages** are prose, lower-case, present tense, and describe the effect.

## What will not be merged

- A runtime dependency, or anything needing Node, a DOM, a clock or a locale in `src`.
- A best-effort conversion: anything dropped or approximated without a diagnostic.
- A TeX engine, macro expansion, or general TikZ parsing (REQUIREMENTS.md §1.1).
- A test that reaches coverage without asserting behaviour, or a coverage-ignore comment.
- A fixture nobody read.

## Package compatibility

After building, `node scripts/check-package.mjs` packs the package, installs that tarball into a
temporary consumer, imports every public entry under Node and Bun, and compiles a TypeScript
consumer. CI runs this on Linux, macOS, and Windows under Node 24 and 26. The required `Verify`
job waits for every consumer case. Release tags must point to a commit already on `main`.
Publishing consumes the verified tarball; prereleases use npm's `next` tag.
