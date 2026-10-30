/**
 * The mutation gate.
 *
 * Coverage says a line ran; it does not say a test would notice the line being
 * wrong. Each mutant below is a precise substitution in `src` plus the suites
 * that must fail once it is applied, and is named for the *property* it
 * breaks. A surviving mutant fails the gate.
 *
 * Two further rules, checked before anything runs:
 *
 * - `from` must occur exactly once in its file, tabs included, so a mutant
 *   breaks when the code around it is reformatted and someone has to re-read
 *   whether the property still holds.
 * - Every module under `src` carries at least one mutant, except the ones
 *   `EXEMPT` lists, which hold no logic. A new module arrives with its mutants.
 *
 * A mutant no input can tell apart from the original is equivalent: remove it
 * and say why in the pull request.
 *
 * The suites must pass before any mutant is applied. `mutation-run.mjs` gives
 * each run its verdict (R-8.2.1); `tests/mutation-run.test.ts` checks them.
 */
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuites } from './mutation-run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Type declarations and re-exports: nothing a mutant could change. */
const EXEMPT = new Set(['src/index.ts', 'src/types.ts']);

const mutants = [
	{
		name: 'a junction is recognised by its kind',
		file: 'src/topology.ts',
		from: "netlist.nodes.filter((node) => node.kind === 'junction')",
		to: "netlist.nodes.filter((node) => node.kind === 'port')",
		tests: ['tests/topology.test.ts', 'tests/conformance.test.ts']
	},
	{
		name: 'junction terminals are left out of the circuit',
		file: 'src/topology.ts',
		from: 'net.terminals.filter((terminal) => !junctions.has(terminal.componentId))',
		to: 'net.terminals.filter(() => true)',
		tests: ['tests/topology.test.ts', 'tests/conformance.test.ts']
	},
	{
		name: 'a terminal written twice on a net counts once',
		file: 'src/topology.ts',
		from: '.map((net) => [...new Set(net)].sort(compare))',
		to: '.map((net) => [...net].sort(compare))',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'a net with no terminal is dropped',
		file: 'src/topology.ts',
		from: '.filter((net) => net.length > 0)',
		to: '.filter(() => true)',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'terminals sort by code unit, not locale',
		file: 'src/topology.ts',
		from: 'return left < right ? -1 : left > right ? 1 : 0;',
		to: 'return left.localeCompare(right);',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'nets sort by their whole contents',
		file: 'src/topology.ts',
		from: "compare(left.join('\\n'), right.join('\\n'))",
		to: 'compare(left[0]!, right[0]!)',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'two spellings of one circuit compare equal',
		file: 'src/topology.ts',
		from: 'for (const net of canonical(nets))',
		to: 'for (const net of nets)',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'a terminal that lost its connection is named as such',
		file: 'src/topology.ts',
		from: 'if (other === undefined) return',
		to: 'if (false) return',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'a terminal on the wrong net is a difference',
		file: 'src/topology.ts',
		from: 'if (other !== net) return',
		to: 'if (false) return',
		tests: ['tests/topology.test.ts', 'tests/conformance.test.ts']
	},
	{
		name: 'a connection the TeX never made is a difference',
		file: 'src/topology.ts',
		from: 'if (!wanted.has(terminal)) return',
		to: 'if (false) return',
		tests: ['tests/topology.test.ts']
	}
];

async function sourceFiles(directory) {
	const entries = await readdir(join(root, directory), { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => (entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : [join(directory, entry.name)]))
	);
	return files.flat().filter((file) => file.endsWith('.ts'));
}

const mutated = new Set(mutants.map((mutant) => mutant.file));
const unguarded = (await sourceFiles('src')).map((file) => relative(root, join(root, file))).filter((file) => !EXEMPT.has(file) && !mutated.has(file));
if (unguarded.length > 0) throw new Error(`Modules with no mutant: ${unguarded.join(', ')}. Add one, or list a logic-free module in EXEMPT.`);
const names = new Set(mutants.map((mutant) => mutant.name));
if (names.size !== mutants.length) throw new Error('Two mutants share a name; each names one property.');

const sandbox = await mkdtemp(join(tmpdir(), 'schemd-circuitikz-mutation-'));
try {
	for (const path of ['src', 'tests']) await cp(join(root, path), join(sandbox, path), { recursive: true });
	for (const path of ['package.json', 'tsconfig.json', 'vitest.config.ts']) await cp(join(root, path), join(sandbox, path));
	await symlink(join(root, 'node_modules'), join(sandbox, 'node_modules'), 'dir');
	const survivors = [];
	const baseline = await runSuites(sandbox, [...new Set(mutants.flatMap((mutant) => mutant.tests))]);
	if (baseline.verdict !== 'passed') throw new Error(`Mutation baseline is not green (${baseline.verdict}); fix the tests first.\n${baseline.output}`);

	for (const mutant of mutants) {
		const path = join(sandbox, mutant.file);
		const original = await readFile(join(root, mutant.file), 'utf8');
		const first = original.indexOf(mutant.from);
		if (first < 0 || original.indexOf(mutant.from, first + mutant.from.length) >= 0) {
			throw new Error(`Mutation target must occur exactly once: ${mutant.name}`);
		}
		await writeFile(path, original.replace(mutant.from, mutant.to));
		let result;
		try {
			result = await runSuites(sandbox, mutant.tests);
		} finally {
			await writeFile(path, original);
		}
		if (result.verdict === 'passed') {
			survivors.push({ mutant, output: result.output });
			console.error(`SURVIVED  ${mutant.name}`);
		} else {
			console.log(`${result.verdict === 'timeout' ? 'TIMEOUT ' : 'KILLED  '}  ${mutant.name}`);
		}
	}

	if (survivors.length > 0) {
		for (const { mutant, output } of survivors) console.error(`\n--- ${mutant.name} ---\n${output.trim()}`);
		process.exitCode = 1;
	} else {
		console.log(`\nMutation score: 100% (${mutants.length}/${mutants.length} killed)`);
	}
} finally {
	await rm(sandbox, { recursive: true, force: true });
}
