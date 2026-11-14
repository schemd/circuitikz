/** Seeded, isolated fuzz contract (R-8.3). No dependency beyond the toolchain. */
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { buildNetlist, compileSchematic, diagnoseSchematic } from '@schemd/core';
import { convertCircuitikz } from '../dist/index.js';
import { LIMITS } from '../dist/limits.js';

/** A span on one line of the input, in UTF-16 columns with an exclusive end. */
function inside(lines, { line, column, endColumn }) {
	assert.ok([line, column, endColumn].every(Number.isInteger));
	assert.ok(line >= 1 && line <= lines.length);
	assert.ok(column >= 1 && endColumn >= column && endColumn <= lines[line - 1].length + 1);
}

function check(input, options) {
	/* Both calls are compared as detached copies: the first is taken before the second call, so a
	   converter that mutates and returns one object cannot hide a difference, and cloning both sides
	   alike lets stable data with any prototype compare equal. */
	const result = structuredClone(convertCircuitikz(input, options));
	assert.deepEqual(structuredClone(convertCircuitikz(input, options)), result, 'conversion is not deterministic');
	assert.equal(typeof result.ok, 'boolean');
	assert.ok(Array.isArray(result.diagnostics));
	assert.ok(Array.isArray(result.sourceMap));
	assert.equal(result.ok, !result.diagnostics.some((d) => d.severity === 'error'));
	const lines = input.split(/\r\n|\r|\n/);
	let previous = [0, 0];
	for (const diagnostic of result.diagnostics) {
		assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'column', 'endColumn', 'line', 'message', 'severity']);
		assert.ok(['syntax', 'unsupported', 'geometry', 'reference', 'limit', 'internal'].includes(diagnostic.code));
		assert.notEqual(diagnostic.code, 'internal', 'An internal diagnostic is always a converter bug.');
		assert.ok(['error', 'warning'].includes(diagnostic.severity));
		assert.equal(typeof diagnostic.message, 'string');
		assert.ok(diagnostic.message.length > 0);
		inside(lines, diagnostic);
		const { line, column } = diagnostic;
		assert.ok(line > previous[0] || line === previous[0] && column >= previous[1]);
		previous = [line, column];
	}
	if (!result.ok) {
		assert.equal(result.source, undefined);
		assert.equal(result.fence, undefined);
		assert.deepEqual(result.sourceMap, []);
	} else {
		assert.equal(typeof result.source, 'string');
		assert.deepEqual(diagnoseSchematic(result.source, result.fence), []);
		assert.ok(buildNetlist(compileSchematic(result.source, result.fence).document).nodes.length >= 0);
		// One CircuitikzMapping per non-blank emitted line, in order, each pointing inside the input (R-3.5).
		const emitted = result.source.split('\n').flatMap((line, index) => line.trim() === '' ? [] : [index + 1]);
		assert.deepEqual(result.sourceMap.map((mapping) => mapping?.schemdLine), emitted);
		for (const mapping of result.sourceMap) {
			assert.deepEqual(Object.keys(mapping).sort(), ['column', 'endColumn', 'line', 'schemdLine']);
			inside(lines, mapping);
		}
	}
}

function random(seed) {
	let state = seed;
	return (maximum) => {
		state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
		return (state >>> 0) % maximum;
	};
}

async function* generated(seed, cases) {
	const next = random(seed);
	// Mutate every fixture input: valid circuits and the documented rejections alike.
	const corpus = [];
	for (const kind of ['conformance', 'rejections']) {
		const root = new URL(`../tests/fixtures/${kind}/`, import.meta.url);
		for (const name of (await readdir(root)).sort()) corpus.push(await readFile(new URL(`${name}/input.tex`, root), 'utf8'));
	}
	const chars = [...'\\{}[]()%,;=+-|$^0123456789abcXYZ \r\n\t', '😀', 'α', '\u0000'];
	const tokens = ['\\begin{circuitikz}', '\\end{circuitikz}', '\\draw', '\\coordinate', '\\node', '(', ')', '[', ']', '{', '}', ';', ',', 'to', '++', '+', '--', '|-', '-|', 'cycle', 'R', '0', '1.00', '(A)', '%comment\r\n'];
	const wrap = (text) => `\\begin{circuitikz}\n${text}\n\\end{circuitikz}`;
	const boundaries = [
		...[-1, 0, 1].map((delta) => ({ input: '%'.repeat(LIMITS.sourceLength + delta) })),
		{ input: '%'.repeat(1_000_000), options: { maxSourceLength: 1_000_000 } },
		...[0, 1].flatMap((delta) => [
			{ input: '{'.repeat(LIMITS.braceDepth + delta) },
			{ input: wrap('\\draw (0,0);'.repeat(LIMITS.statements + delta)) },
			{ input: wrap('\\draw (0,0)' + ' -- (1,0)'.repeat(LIMITS.pathElements - 1 + delta) + ';') },
			{ input: wrap('\\draw (0,0)' + ' to[R] (1,0)'.repeat(LIMITS.components + delta) + ';') }
		])
	];
	for (let index = 0; index < cases; index += 1) {
		if (index < boundaries.length) { yield { ...boundaries[index], index }; continue; }
		let input = '';
		const mode = index % 5;
		if (mode === 0) for (let size = next(400); size > 0; size -= 1) input += chars[next(chars.length)];
		else if (mode === 1) for (let size = next(100); size > 0; size -= 1) input += tokens[next(tokens.length)] + ' ';
		else if (mode === 2) {
			input = corpus[next(corpus.length)];
			const start = next(input.length);
			input = input.slice(0, start) + tokens[next(tokens.length)] + input.slice(start + next(12));
		} else if (mode === 3) {
			const n = next(1000) - 500;
			input = `\\begin{circuitikz}\n\\coordinate (A) at (${n}.01,${n}cm);\n\\draw (A) -- +(2,0) to[R=$R_{${next(10)}}$] ++(0,2) |- (A) -- cycle;\n\\end{circuitikz}`;
		} else {
			const large = next(3000);
			input = ['%'.repeat(large), '{'.repeat(large), `\\begin{circuitikz}\\draw (0,0) to[R=${'a'.repeat(large)}`, `\\begin{circuitikz}\\draw (${next(100)}.${'1'.repeat(next(20))},0);`][next(4)];
		}
		const options = [undefined, { strict: true }, { title: 'Fuzz circuit' }, { maxSourceLength: 1 + next(1_000_000) }][next(4)];
		yield { input, index, options };
	}
}

if (!isMainThread) {
	if (workerData.mode === 'single') {
		try { check(workerData.input, workerData.options); parentPort.postMessage({ failed: false }); }
		catch (error) { parentPort.postMessage({ failed: true, error: String(error) }); }
	} else {
		let completed = 0;
		for await (const { input, index, options } of generated(workerData.seed, workerData.cases)) {
			parentPort.postMessage({ active: index, input, options });
			try { check(input, options); completed += 1; }
			catch (error) { parentPort.postMessage({ failed: true, input, index, options, error: String(error) }); break; }
		}
		// Only this message ends a passing run: an exit, even with code 0, is never success.
		if (completed === workerData.cases) parentPort.postMessage({ failed: false, completed });
	}
} else {
	function argument(name, fallback, maximum, minimum = 1) {
		const raw = process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
		const value = raw === undefined ? fallback : Number(raw);
		if (raw === '' || !Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`--${name} must be an integer from ${minimum} through ${maximum}`);
		return value;
	}
	const replay = process.argv.find((v) => v.startsWith('--replay='))?.slice('--replay='.length);
	const seed = argument('seed', 0x5c4e4d, 0xffffffff);
	const cases = argument('cases', 20_000, 1_000_000);
	// Minimization is bounded so CI keeps time to upload the reproducer: candidates and wall time both.
	const attemptBudget = argument('minimize-attempts', 2000, 1_000_000, 0);
	const MINIMIZE_MS = 120_000;

	function isolated(data) {
		return new Promise((resolve) => {
			const worker = new Worker(new URL(import.meta.url), { workerData: data });
			let active = { input: data.input, options: data.options, index: 0 };
			let done = false;
			let timer;
			const finish = (result) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				void worker.terminate();
				resolve(result);
			};
			const arm = () => {
				clearTimeout(timer);
				timer = setTimeout(() => finish({ failed: true, ...active, error: 'Worker exceeded the per-input 2000 ms deadline.' }), 2000);
			};
			arm();
			worker.on('message', (message) => {
				if (message.active !== undefined) { active = { input: message.input, options: message.options, index: message.active }; arm(); }
				else finish(message);
			});
			worker.on('error', (error) => finish({ failed: true, ...active, error: String(error) }));
			worker.on('exit', (code) => finish({ failed: true, ...active, error: `Worker exited ${code} before reporting a result.` }));
		});
	}

	// Each candidate runs alone in a fresh worker; a seeded prefix replays the run up to the failing index.
	const alone = (input, options) => isolated({ mode: 'single', input, options });
	const prefix = (record) => isolated({ mode: 'run', seed: record.seed, cases: record.index + 1 });

	if (replay !== undefined) {
		// Replays a saved artifact the way it was recorded to reproduce, and fails while it still does.
		const record = JSON.parse(await readFile(replay, 'utf8'));
		const outcome = record.reproduces === 'standalone' ? await alone(record.input, record.options)
			: await alone(record.input, record.options).then((single) => single.failed ? single : prefix(record));
		if (outcome.failed) throw new Error(`Replay reproduces the failure: ${outcome.error}`);
		console.log(`Replay passes: ${replay} no longer fails.`);
		process.exit(0);
	}

	console.log(`Fuzz seed: ${seed}; cases: ${cases}`);
	const failure = await isolated({ mode: 'run', seed, cases });
	if (failure.failed || failure.completed !== cases) {
		const path = `fuzz-failure-${seed}.json`;
		let minimal = failure.input ?? '';
		let attempts = 0;
		let reproduces = 'unchecked';
		const save = (minimized) => writeFile(path, JSON.stringify({ seed, index: failure.index, error: failure.error, options: failure.options, reproduces, minimized, attempts, original: failure.input, input: minimal }, null, 2) + '\n');
		// The original is on disk before the first candidate runs, and every reduction is saved as it lands.
		await save(false);
		// Shrinking runs candidates alone, so it only starts once the original fails alone too.
		reproduces = (await alone(failure.input, failure.options)).failed ? 'standalone'
			: (await prefix({ seed, index: failure.index })).failed ? 'with-prefix' : 'no';
		if (reproduces !== 'standalone') {
			await save(false);
			throw new Error(`Fuzz contract failed: ${failure.error}; ${reproduces === 'with-prefix' ? `the input fails only after the earlier inputs of its seed; replay with --seed=${seed} --cases=${failure.index + 1}` : 'the failure did not reproduce in a fresh worker or after its seeded prefix'}. Saved unminimized to ${path}`);
		}
		const deadline = Date.now() + MINIMIZE_MS;
		let minimized = true;
		/* Delta debugging, followed by single-character deletion: 1-minimal for
		   the reproducible contract failure, always checked in a timed worker. */
		search: for (let chunk = Math.max(1, Math.floor(minimal.length / 2)); chunk >= 1; chunk = Math.floor(chunk / 2)) {
			let reduced;
			do {
				reduced = false;
				for (let start = 0; start < minimal.length;) {
					if (attempts >= attemptBudget || Date.now() >= deadline) { minimized = false; break search; }
					attempts += 1;
					const candidate = minimal.slice(0, start) + minimal.slice(start + chunk);
					if ((await isolated({ mode: 'single', input: candidate, options: failure.options })).failed) { minimal = candidate; reduced = true; await save(false); }
					else start += chunk;
				}
			} while (chunk === 1 && reduced);
		}
		await save(minimized);
		throw new Error(`Fuzz contract failed: ${failure.error}; ${minimized ? 'minimized' : 'partly minimized (budget spent)'} input saved to ${path}`);
	}
	console.log(`PASS: ${cases} reproducible fuzz cases (${cases * 2} conversions).`);
}
