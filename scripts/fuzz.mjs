/** Seeded, isolated fuzz contract (R-8.3). No dependency beyond the toolchain. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
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
	assert.deepEqual(Object.keys(result).sort(), ['diagnostics', 'fence', 'ok', 'source', 'sourceMap']);
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
		/* Only that core can build a netlist from it: whether that netlist wires what the TeX wires (R-3.3)
		   is the converter's own oracle, which reports a mismatch as the internal diagnostic refused above. */
		buildNetlist(compileSchematic(result.source, result.fence).document);
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

/** Every fixture input, valid circuits and the documented rejections alike: each folder that holds an
 * input.tex, as the fixture suites glob them, so a stray file such as .DS_Store is not a fixture. */
async function fixtures() {
	const corpus = [];
	for (const kind of ['conformance', 'rejections']) {
		const root = new URL(`../tests/fixtures/${kind}/`, import.meta.url);
		const names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
		for (const name of names) if (existsSync(new URL(`${name}/input.tex`, root))) corpus.push(await readFile(new URL(`${name}/input.tex`, root), 'utf8'));
	}
	return corpus;
}

/** What a seed's inputs are built from: a seeded prefix only replays the same inputs while this holds. */
const fingerprint = async () => createHash('sha256').update(JSON.stringify([await fixtures(), LIMITS])).digest('hex');

/** How an input fails, stable across inputs: the error class and the frames from the throw up to check(). */
function signature(error) {
	const frames = [];
	for (const line of String(error?.stack ?? '').split('\n').filter((text) => /^\s*at /.test(text))) {
		frames.push(line.match(/([^/\\(\s]+:\d+:\d+)\)?\s*$/)?.[1] ?? line.trim());
		if (/^\s*at check\b/.test(line)) break;
	}
	return [error?.name ?? typeof error, ...frames].join(' ');
}

async function* generated(seed, cases) {
	const next = random(seed);
	const corpus = await fixtures();
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
	// Imports are done: the per-input deadline starts now, not while the worker loads core and dist.
	parentPort.postMessage({ started: true });
	if (workerData.mode === 'single') {
		try { check(workerData.input, workerData.options); parentPort.postMessage({ failed: false }); }
		catch (error) { parentPort.postMessage({ failed: true, error: String(error), signature: signature(error) }); }
	} else {
		let completed = 0;
		for await (const { input, index, options } of generated(workerData.seed, workerData.cases)) {
			parentPort.postMessage({ active: index, input, options });
			try { check(input, options); completed += 1; }
			catch (error) { parentPort.postMessage({ failed: true, input, index, options, error: String(error), signature: signature(error) }); break; }
		}
		// Only this message ends a passing run: an exit, even with code 0, is never success.
		if (completed === workerData.cases) parentPort.postMessage({ failed: false, completed });
	}
} else {
	const unknown = process.argv.slice(2).find((v) => !/^--(seed|cases|minimize-attempts|replay)=/.test(v));
	if (unknown !== undefined) throw new TypeError(`Unknown argument ${unknown}: use --seed=, --cases=, --minimize-attempts= or --replay=, each with its value after the =`);
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
	const STARTUP_MS = 30_000;

	function isolated(data) {
		return new Promise((resolve) => {
			const worker = new Worker(new URL(import.meta.url), { workerData: data });
			// A run has no input until its worker names one; a failure before that is not the converter's.
			let active = data.mode === 'single' ? { input: data.input, options: data.options, index: 0 } : { index: undefined };
			let started = false;
			let done = false;
			let timer;
			const finish = (result) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				void worker.terminate();
				resolve(result);
			};
			const fail = (error, signature) => finish(started
				? { failed: true, ...active, error, signature }
				: { failed: true, infrastructure: true, index: undefined, error, signature: 'startup' });
			const arm = (ms) => {
				clearTimeout(timer);
				timer = setTimeout(() => fail(started ? 'Worker exceeded the per-input 2000 ms deadline.' : `Worker did not start within ${ms} ms.`, 'deadline'), ms);
			};
			arm(STARTUP_MS);
			worker.on('message', (message) => {
				if (message.started) { started = true; arm(2000); }
				else if (message.active !== undefined) { active = { input: message.input, options: message.options, index: message.active }; arm(2000); }
				else finish(message);
			});
			worker.on('error', (error) => fail(String(error), `uncaught ${signature(error)}`));
			worker.on('exit', (code) => fail(`Worker exited ${code} before reporting a result.`, `exit ${code}`));
		});
	}

	// Each candidate runs alone in a fresh worker; a seeded prefix replays the run up to the failing index.
	const alone = (input, options) => isolated({ mode: 'single', input, options });
	const prefix = (record) => isolated({ mode: 'run', seed: record.seed, cases: record.index + 1 });
	// The same failure: the same way of failing, and for a prefix, at the recorded input and no earlier one.
	const same = (outcome, signature, record) => outcome.failed && !outcome.infrastructure && outcome.signature === signature
		&& (record === undefined || outcome.index === record.index && outcome.input === record.original);

	if (replay !== undefined) {
		// Replays a saved artifact the way it was recorded to reproduce, and fails while it still does.
		const record = JSON.parse(await readFile(replay, 'utf8'));
		let outcome = await alone(record.input, record.options);
		let reproduced = same(outcome, record.signature);
		if (record.reproduces !== 'standalone' && !outcome.failed) {
			// The seed rebuilds its inputs from today's fixtures and limits: only the recorded ones replay the failure.
			if (record.fingerprint !== await fingerprint()) throw new Error(`Cannot replay ${replay}: the fixtures or limits changed since it was recorded, so seed ${record.seed} no longer builds the same inputs. Replay it on the commit that recorded it.`);
			outcome = await prefix(record);
			reproduced = same(outcome, record.signature, record);
		}
		if (outcome.failed) throw new Error(`Replay ${reproduced ? 'reproduces the failure' : `fails, but not as recorded (input ${outcome.index ?? 'none'})`}: ${outcome.error}`);
		console.log(`Replay passes: ${replay} no longer fails.`);
		process.exit(0);
	}

	console.log(`Fuzz seed: ${seed}; cases: ${cases}`);
	const failure = await isolated({ mode: 'run', seed, cases });
	if (failure.failed || failure.completed !== cases) {
		if (failure.index === undefined) throw new Error(`Fuzz run failed before its first input, so no converter input is to blame: ${failure.error}`);
		const path = `fuzz-failure-${seed}.json`;
		let minimal = failure.input;
		let error = failure.error;
		let attempts = 0;
		let reproduces = 'unchecked';
		const recorded = await fingerprint();
		/* `error` is how `input` fails; `originalError` how `original` failed in the run. Written whole to a
		   temporary file and renamed, so a kill mid-write never leaves a broken or truncated record. */
		const save = async (minimized) => {
			await writeFile(`${path}.tmp`, JSON.stringify({ seed, index: failure.index, error, originalError: failure.error, signature: failure.signature, options: failure.options, reproduces, minimized, attempts, fingerprint: recorded, original: failure.input, input: minimal }, null, 2) + '\n');
			await rename(`${path}.tmp`, path);
		};
		// The original is on disk before the first candidate runs, and every reduction is saved as it lands.
		await save(false);
		// Shrinking runs candidates alone, so it only starts once the original fails alone too, the same way.
		const single = await alone(failure.input, failure.options);
		reproduces = same(single, failure.signature) ? 'standalone'
			: same(await prefix({ seed, index: failure.index }), failure.signature, { index: failure.index, original: failure.input }) ? 'with-prefix' : 'no';
		if (reproduces === 'standalone') error = single.error;
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
					const outcome = await alone(candidate, failure.options);
					// A candidate that fails another way (another clause, a deadline) is a different bug: not a reduction.
					if (same(outcome, failure.signature)) { minimal = candidate; error = outcome.error; reduced = true; await save(false); }
					else start += chunk;
				}
			} while (chunk === 1 && reduced);
		}
		await save(minimized);
		throw new Error(`Fuzz contract failed: ${error}; ${minimized ? 'minimized' : 'partly minimized (budget spent)'} input saved to ${path}`);
	}
	console.log(`PASS: ${cases} reproducible fuzz cases (${cases * 2} conversions).`);
}
