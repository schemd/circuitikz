import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const rejected = (diagnostics) => `{ok:false,source:undefined,fence:undefined,sourceMap:[],diagnostics:${diagnostics}}`;
const error = (fields) => `{code:'syntax',message:'m',line:1,column:1,endColumn:1,severity:'error',${fields}}`;
// A source core accepts, as M2 emits it: one component inside its fence.
// Two components with a blank line between them: the source map skips it.
const twoParts = `{ok:true,source:'capacitor:C1 "100" at (180, 80) #cyan\\n\\ncapacitor:C2 at (300, 80) #cyan\\n',fence:{bounds:{width:400,height:200},title:'T'},sourceMap:[{schemdLine:1,line:1,column:1,endColumn:1},{schemdLine:3,line:1,column:1,endColumn:1}],diagnostics:[]}`;
const accepted = (fields) => `{ok:true,source:'capacitor:C1 "100" at (180, 80) #cyan\\n',fence:{bounds:{width:400,height:200},title:'T'},sourceMap:[{schemdLine:1,line:1,column:1,endColumn:1}],diagnostics:[],${fields}}`;
// Reports at the very end of the input: the last line, one past its last UTF-16 unit.
const atEnd = (split) => `const lines=t.split(${split});const line=lines.length;const column=lines[line-1].length+1;return ${rejected('[{code:\'syntax\',message:\'m\',line,column,endColumn:column,severity:\'error\'}]')};`;

/** Runs the real fuzz script against a stand-in converter in a scratch package, so a converter
 * that breaks the contract can be shown to fail the gate. Nothing in src or dist changes. */
async function fuzz(converter, args = ['--cases=1', '--seed=1'], output = 'fuzz-failure-1.json', { kill, replay } = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'circuitikz-fuzz-contract-'));
	try {
		for (const path of ['scripts', 'dist', 'tests/fixtures/conformance/one', 'tests/fixtures/rejections/two']) await mkdir(join(directory, path), { recursive: true });
		await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
		await cp('scripts/fuzz.mjs', join(directory, 'scripts/fuzz.mjs'));
		await writeFile(join(directory, 'package.json'), '{"type":"module"}');
		await writeFile(join(directory, 'dist/index.js'), converter);
		await writeFile(join(directory, 'dist/limits.js'), 'export const LIMITS = {sourceLength:4,braceDepth:2,statements:2,pathElements:2,components:2};');
		await writeFile(join(directory, 'tests/fixtures/conformance/one/input.tex'), '\\begin{circuitikz}\\end{circuitikz}');
		await writeFile(join(directory, 'tests/fixtures/rejections/two/input.tex'), '\\begin{circuitikz}\\draw (0,0)\\end{circuitikz}');
		const result = spawnSync(process.execPath, ['scripts/fuzz.mjs', ...args], { cwd: directory, encoding: 'utf8', timeout: kill ?? 15_000 });
		if (kill === undefined) expect(result.error).toBeUndefined();
		else expect(result.error?.code).toBe('ETIMEDOUT');
		const failure = await readFile(join(directory, output), 'utf8').then(JSON.parse, () => undefined);
		if (replay === undefined) return { status: result.status, output: result.stdout + result.stderr, failure };
		// Replays the written artifact in a fresh process, against the same converter or a replacement.
		if (replay !== true) await writeFile(join(directory, 'dist/index.js'), replay);
		const again = spawnSync(process.execPath, ['scripts/fuzz.mjs', `--replay=${output}`], { cwd: directory, encoding: 'utf8', timeout: 15_000 });
		expect(again.error).toBeUndefined();
		return { status: result.status, output: result.stdout + result.stderr, failure, replayed: { status: again.status, output: again.stdout + again.stderr } };
	} finally { await rm(directory, { force: true, recursive: true }); }
}

describe('fuzz infrastructure', () => {
	it('passes a converter that keeps the contract, across every input mode', async () => {
		const result = await fuzz(`export function convertCircuitikz(){return ${rejected(`[${error('')}]`)};}`, ['--cases=40', '--seed=1']);
		expect(result.status).toBe(0);
		expect(result.output).toContain('Fuzz seed: 1; cases: 40');
		expect(result.output).toContain('PASS: 40 reproducible fuzz cases (80 conversions).');
		expect(result.failure).toBeUndefined();
	});

	it('writes a minimized reproducible input and exits nonzero for a thrown error', async () => {
		const { status, failure } = await fuzz('export function convertCircuitikz(){throw new Error("controlled failure");}');
		expect(status).toBe(1);
		expect(failure).toMatchObject({ seed: 1, index: 0, original: '%%%', input: '', error: 'Error: controlled failure' });
	});

	it('terminates a hung converter in its worker and records the responsible input', async () => {
		const { status, failure } = await fuzz('export function convertCircuitikz(){while(true){}}');
		expect(status).toBe(1);
		expect(failure).toMatchObject({ index: 0, original: '%%%', input: '', error: 'Worker exceeded the per-input 2000 ms deadline.' });
	}, 20_000);

	// Each stand-in breaks one clause of R-8.3.2 on every input, so the minimized input is empty.
	it.each([
		{ name: 'a result of the wrong shape', converter: 'return {ok:"no",diagnostics:[],sourceMap:[]};', error: 'AssertionError' },
		{ name: 'a different result on the second call', converter: `globalThis.n=(globalThis.n??0)+1;return ${rejected(`[${error("message:'m'+globalThis.n")}]`)};`, error: 'conversion is not deterministic' },
		{ name: 'ok with an error diagnostic', converter: `return {ok:true,source:'',fence:undefined,sourceMap:[],diagnostics:[${error('')}]};`, error: 'AssertionError' },
		{ name: 'a diagnostic on a line the input lacks', converter: `return ${rejected(`[${error('line:2')}]`)};`, error: 'AssertionError' },
		{ name: 'a span past the end of its line', converter: `return ${rejected(`[${error('column:9,endColumn:9')}]`)};`, error: 'AssertionError' },
		{ name: 'an end column before its start', converter: `return ${rejected(`[${error('column:2,endColumn:1')}]`)};`, error: 'AssertionError' },
		{ name: 'diagnostics out of order', converter: `return ${rejected(`[${error('column:3,endColumn:3')},${error('')}]`)};`, error: 'AssertionError' },
		{ name: 'an internal diagnostic', converter: `return ${rejected(`[${error("code:'internal'")}]`)};`, error: 'An internal diagnostic is always a converter bug.' },
		{ name: 'an unknown diagnostic field', converter: `return ${rejected(`[${error('extra:1')}]`)};`, error: 'AssertionError' },
		{ name: 'a rejection with a source', converter: `return {ok:false,source:'x',fence:undefined,sourceMap:[],diagnostics:[${error('')}]};`, error: 'AssertionError' },
		{ name: 'a rejection with a fence', converter: `return {ok:false,source:undefined,fence:{},sourceMap:[],diagnostics:[${error('')}]};`, error: 'AssertionError' },
		{ name: 'a rejection with a source map', converter: `return {ok:false,source:undefined,fence:undefined,sourceMap:[{}],diagnostics:[${error('')}]};`, error: 'AssertionError' },
		{ name: 'diagnostics that are not an array', converter: 'return {ok:true,source:"",fence:undefined,sourceMap:[],diagnostics:{}};', error: 'AssertionError' },
		{ name: 'a source map that is not an array', converter: `return {ok:false,source:undefined,fence:undefined,sourceMap:{},diagnostics:[${error('')}]};`, error: 'AssertionError' },
		{ name: 'a rejection with only a warning', converter: `return ${rejected(`[${error("severity:'warning'")}]`)};`, error: 'AssertionError' },
		{ name: 'an unknown diagnostic code', converter: `return ${rejected(`[${error("code:'bogus'")}]`)};`, error: 'AssertionError' },
		{ name: 'an unknown severity beside an error', converter: `return ${rejected(`[${error('')},${error("severity:'info'")}]`)};`, error: 'AssertionError' },
		{ name: 'an empty message', converter: `return ${rejected(`[${error("message:''")}]`)};`, error: 'AssertionError' },
		{ name: 'a message that is not a string', converter: `return ${rejected(`[${error("message:['m']")}]`)};`, error: 'AssertionError' },
		{ name: 'line 0', converter: `return ${rejected(`[${error('line:0')}]`)};`, error: 'AssertionError' },
		{ name: 'column 0', converter: `return ${rejected(`[${error('column:0,endColumn:1')}]`)};`, error: 'AssertionError' },
		{ name: 'a fractional column', converter: `return ${rejected(`[${error('column:1.5,endColumn:2')}]`)};`, error: 'AssertionError' },
		{ name: 'a column given as a string', converter: `return ${rejected(`[${error("column:'1'")}]`)};`, error: 'AssertionError' },
		{ name: 'a missing diagnostic field', converter: `return ${rejected("[{code:'syntax',message:'m',line:1,column:1,severity:'error'}]")};`, error: 'AssertionError' },
		{ name: 'a later line before an earlier one', converter: `return ${rejected(`[${error('')},${error('')}].map((d,i)=>({...d,line:i?1:2}))`)};`, error: 'AssertionError' },
		{ name: 'a success that core rejects', converter: `return {...${accepted('')},source:'capacitor:C1 at (900, 80) #cyan\\n'};`, error: 'AssertionError' },
		{ name: 'a success with no fence', converter: `return {...${accepted('')},fence:undefined};`, error: 'SchematicSyntaxError: Parser options must be an object.' },
		{ name: 'a success whose source map misses a line', converter: `return {...${accepted('')},sourceMap:[]};`, error: 'AssertionError' },
		{ name: 'a success with no source', converter: `return {...${accepted('')},source:undefined};`, error: 'AssertionError' },
		// Each source-map entry is a CircuitikzMapping: four integer fields, the emitted line it maps, and a span inside the input (R-3.5).
		...[
			['a null source-map entry', 'null'],
			['a source-map entry with a missing field', '{schemdLine:1,line:1,column:1}'],
			['a source-map entry with an extra field', '{schemdLine:1,line:1,column:1,endColumn:1,extra:1}'],
			['a source-map entry for a line the source lacks', '{schemdLine:2,line:1,column:1,endColumn:1}'],
			['a source-map entry for line 0 of the source', '{schemdLine:0,line:1,column:1,endColumn:1}'],
			['a source-map entry on a line the input lacks', '{schemdLine:1,line:2,column:1,endColumn:1}'],
			['a source-map entry past the end of its line', '{schemdLine:1,line:1,column:9,endColumn:9}'],
			['a source-map entry that ends before it starts', '{schemdLine:1,line:1,column:2,endColumn:1}'],
			['a source-map entry with column 0', '{schemdLine:1,line:1,column:0,endColumn:1}'],
			['a source-map entry with a fractional column', '{schemdLine:1,line:1,column:1.5,endColumn:2}'],
			['a source-map entry with a column given as a string', "{schemdLine:1,line:1,column:'1',endColumn:1}"]
		].map(([name, entry]) => ({ name, converter: `return {...${accepted('')},sourceMap:[${entry}]};`, error: 'AssertionError' })),
		{ name: 'a source map that maps the blank line', converter: `return {...${twoParts},sourceMap:[{schemdLine:1,line:1,column:1,endColumn:1},{schemdLine:2,line:1,column:1,endColumn:1}]};`, error: 'AssertionError' },
		{ name: 'a source map out of order', converter: `return {...${twoParts},sourceMap:[{schemdLine:3,line:1,column:1,endColumn:1},{schemdLine:1,line:1,column:1,endColumn:1}]};`, error: 'AssertionError' },
		// The second call mutates and returns the object the first call returned, so comparing the two references proves nothing.
		{ name: 'a reused result whose message changes on every call', converter: `globalThis.r??=${rejected(`[${error('')}]`)};globalThis.n=(globalThis.n??0)+1;globalThis.r.diagnostics[0].message='call '+globalThis.n;return globalThis.r;`, error: 'conversion is not deterministic' },
		{ name: 'a reused diagnostics array that grows on every call', converter: `globalThis.d??=[];globalThis.d.push(${error('')});return {...${rejected('globalThis.d')}};`, error: 'conversion is not deterministic' }
	])('fails the gate for $name', async ({ converter, error: expected }) => {
		const { status, failure } = await fuzz(`export function convertCircuitikz(){${converter}}`);
		expect(status).toBe(1);
		expect(failure?.index).toBe(0);
		expect(failure?.input).toBe('');
		expect(failure?.error).toContain(expected);
	});

	// Controls: results at the edge of the contract that a correct converter may return; the span control covers CR, CRLF and emoji inputs.
	it.each([
		{ name: 'a success core compiles, with a warning', converter: `return {...${accepted('')},diagnostics:[${error("severity:'warning'")}]};` },
		{ name: 'two diagnostics at one position', converter: `return ${rejected(`[${error('')},${error('')}]`)};` },
		{ name: "a span one past each input's end", converter: atEnd('/\\r\\n|\\r|\\n/') },
		{ name: 'a source map that skips a blank line', converter: `return ${twoParts};` },
		{ name: 'a result with a null prototype', converter: `return Object.assign(Object.create(null),${rejected(`[${error('')}]`)});` },
		{ name: 'a diagnostic with a null prototype', converter: `return ${rejected(`[Object.assign(Object.create(null),${error('')})]`)};` },
		{ name: 'the same result object, unchanged, on every call', converter: `return globalThis.r??=${rejected(`[${error('')}]`)};` }
	])('passes a converter that returns $name', async ({ converter }) => {
		const result = await fuzz(`export function convertCircuitikz(t){${converter}}`, ['--cases=200', '--seed=1']);
		expect(result.output).toContain('PASS: 200 reproducible fuzz cases (400 conversions).');
		expect(result.status).toBe(0);
	});

	it.each([
		{ name: 'counts CRLF as two lines', split: '/[\\r\\n]/', input: '\r\n' },
		{ name: 'counts only LF line ends', split: "'\\n'", input: '\r' },
		{ name: 'measures columns in UTF-8 bytes', split: '/\\r\\n|\\r|\\n/', input: 'α', bytes: true }
	])('minimizes to the line end it gets wrong when a converter $name', async ({ split, input, bytes }) => {
		const converter = bytes ? atEnd(split).replace('lines[line-1].length', 'Buffer.byteLength(lines[line-1])') : atEnd(split);
		const { status, failure } = await fuzz(`export function convertCircuitikz(t){${converter}}`, ['--cases=200', '--seed=1']);
		expect(status).toBe(1);
		expect(failure?.input).toBe(input);
		expect(failure?.error).toContain('AssertionError');
	});

	it('minimizes to the one character that breaks a converter, from a random input', async () => {
		const { status, failure } = await fuzz('export function convertCircuitikz(t){if(t.includes("α"))throw new Error("alpha");return ' + rejected(`[${error('')}]`) + ';}', ['--cases=200', '--seed=1']);
		expect(status).toBe(1);
		expect(failure?.original).toContain('α');
		expect(failure?.original.length).toBeGreaterThan(1);
		expect(failure?.input).toBe('α');
		expect(failure?.error).toBe('Error: alpha');
	});

	it('replays the same failure from the same seed, and another from a different seed', async () => {
		const converter = 'export function convertCircuitikz(t){if(t.includes("α"))throw new Error("alpha");return ' + rejected(`[${error('')}]`) + ';}';
		const first = await fuzz(converter, ['--cases=200', '--seed=1']);
		const again = await fuzz(converter, ['--cases=200', '--seed=1']);
		const other = await fuzz(converter, ['--cases=200', '--seed=2']);
		expect(again.failure).toEqual(first.failure);
		expect(other.status).toBe(1);
		expect(other.output).toContain('Fuzz seed: 2; cases: 200');
		expect(other.output).toContain('fuzz-failure-2.json');
	});

	it('records the options a failure needs and replays them while minimizing', async () => {
		const { status, failure } = await fuzz(`export function convertCircuitikz(t,o){if(o?.strict)throw new Error("strict");return ${rejected(`[${error('')}]`)};}`, ['--cases=200', '--seed=1']);
		expect(status).toBe(1);
		expect(failure).toMatchObject({ options: { strict: true }, input: '', error: 'Error: strict' });
		expect(failure?.index).toBeGreaterThan(0);
	});

	it.each([3, 0])('fails the gate when the converter ends its worker with code %i', async (code) => {
		const { status, output, failure } = await fuzz(`export function convertCircuitikz(){process.exit(${code});}`);
		expect(status).toBe(1);
		expect(output).not.toContain('PASS');
		expect(failure).toMatchObject({ index: 0, original: '%%%', input: '', error: `Worker exited ${code} before reporting a result.` });
	});

	it('fails the gate when the converter ends its worker cleanly after some cases', async () => {
		const { status, output, failure } = await fuzz(`export function convertCircuitikz(t){if(t.length===5)process.exit(0);return ${rejected(`[${error('')}]`)};}`, ['--cases=40', '--seed=1']);
		expect(status).toBe(1);
		expect(output).not.toContain('PASS');
		// The third input, five percent signs, was active when the worker left.
		expect(failure).toMatchObject({ index: 2, original: '%%%%%', error: 'Worker exited 0 before reporting a result.' });
	});

	it('saves the failing input before minimizing, and stops at the attempt budget', async () => {
		const converter = `export function convertCircuitikz(t){if(t.length===1000000)throw new Error("only at a million");return ${rejected(`[${error('')}]`)};}`;
		const { status, output, failure } = await fuzz(converter, ['--cases=4', '--seed=1', '--minimize-attempts=6']);
		expect(status).toBe(1);
		expect(output).toContain('fuzz-failure-1.json');
		expect(failure).toMatchObject({ index: 3, error: 'Error: only at a million', attempts: 6, minimized: false });
		expect(failure.original).toHaveLength(1_000_000);
		expect(failure.input).toHaveLength(1_000_000);
	});

	it('leaves the original failure on disk when the run is killed while minimizing', async () => {
		const converter = `export function convertCircuitikz(t){if(t.length===1000000)throw new Error("only at a million");return ${rejected(`[${error('')}]`)};}`;
		const { failure } = await fuzz(converter, ['--cases=4', '--seed=1'], 'fuzz-failure-1.json', { kill: 4000 });
		expect(failure).toMatchObject({ seed: 1, index: 3, error: 'Error: only at a million', minimized: false });
		expect(failure.original).toHaveLength(1_000_000);
	}, 20_000);

	it('replays a minimized artifact: it still fails against the broken converter and passes once fixed', async () => {
		const broken = 'export function convertCircuitikz(){throw new Error("controlled failure");}';
		const fixed = `export function convertCircuitikz(){return ${rejected(`[${error('')}]`)};}`;
		const still = await fuzz(broken, undefined, undefined, { replay: true });
		expect(still.failure).toMatchObject({ reproduces: 'standalone', minimized: true, input: '' });
		expect(still.replayed.status).toBe(1);
		expect(still.replayed.output).toContain('Replay reproduces the failure: Error: controlled failure');
		const repaired = await fuzz(broken, undefined, undefined, { replay: fixed });
		expect(repaired.replayed.status).toBe(0);
		expect(repaired.replayed.output).toContain('Replay passes');
	});

	it('keeps a failure that needs earlier inputs unminimized, and replays it with its seeded prefix', async () => {
		// '%%%%' right after '%%%' answers differently from its second call; alone, or after itself, it never does.
		const converter = `export function convertCircuitikz(t){const message=t==='%%%%'&&globalThis.last==='%%%'?'changed':'stable';globalThis.last=t;return ${rejected(`[${error('message')}]`)};}`;
		const { status, output, failure, replayed } = await fuzz(converter, ['--cases=40', '--seed=1'], undefined, { replay: true });
		expect(status).toBe(1);
		expect(output).toContain('only after the earlier inputs of its seed');
		expect(failure).toMatchObject({ index: 1, original: '%%%%', input: '%%%%', reproduces: 'with-prefix', minimized: false, attempts: 0 });
		expect(replayed.status).toBe(1);
		expect(replayed.output).toContain('Replay reproduces the failure');
	});

	it('records a failure it cannot reproduce at all, without claiming a minimized input', async () => {
		// Fails once per scratch package: the first call ever leaves a marker, so no replay fails again.
		const converter = `import {existsSync,writeFileSync} from 'node:fs';export function convertCircuitikz(){if(!existsSync('once')){writeFileSync('once','');throw new Error("first call only");}return ${rejected(`[${error('')}]`)};}`;
		const { status, output, failure, replayed } = await fuzz(converter, undefined, undefined, { replay: true });
		expect(status).toBe(1);
		expect(output).toContain('did not reproduce');
		expect(failure).toMatchObject({ index: 0, original: '%%%', input: '%%%', reproduces: 'no', minimized: false, attempts: 0 });
		expect(replayed.status).toBe(0);
	});

	it('keeps the original unreduced with a minimization budget of zero', async () => {
		const { status, output, failure } = await fuzz('export function convertCircuitikz(){throw new Error("always");}', ['--cases=1', '--seed=1', '--minimize-attempts=0']);
		expect(status).toBe(1);
		expect(output).toContain('partly minimized (budget spent)');
		expect(failure).toMatchObject({ attempts: 0, original: '%%%', input: '%%%', minimized: false });
	});

	it('checkpoints each reduction and marks a finished minimization', async () => {
		const { failure } = await fuzz(`export function convertCircuitikz(t){if(t.includes("α"))throw new Error("alpha");return ${rejected(`[${error('')}]`)};}`, ['--cases=200', '--seed=1']);
		expect(failure).toMatchObject({ input: 'α', minimized: true, reproduces: 'standalone' });
		expect(failure.attempts).toBeGreaterThan(0);
	});

	it('checks the inputs at each ceiling and one past it before any random input', async () => {
		// The stand-in limits are 4 characters, 2 braces, 2 statements, 2 path elements and 2 components.
		const wrap = (text) => `\\begin{circuitikz}\n${text}\n\\end{circuitikz}`;
		const expected = ['%%%', '%%%%', '%%%%%', '%'.repeat(1_000_000), ...[2, 3].flatMap((n) => [
			'{'.repeat(n), wrap('\\draw (0,0);'.repeat(n)), wrap('\\draw (0,0)' + ' -- (1,0)'.repeat(n - 1) + ';'), wrap('\\draw (0,0)' + ' to[R] (1,0)'.repeat(n) + ';')
		])];
		const { status, failure } = await fuzz(`import {writeFileSync} from 'node:fs';export function convertCircuitikz(t,o){globalThis.seen??=[];globalThis.seen.push([t,o]);writeFileSync('seen.json',JSON.stringify(globalThis.seen));return ${rejected(`[${error('')}]`)};}`, [`--cases=${expected.length}`, '--seed=1'], 'seen.json');
		expect(status).toBe(0);
		const seen = failure.filter((_, i) => i % 2 === 0);
		expect(seen.map(([text]) => text)).toEqual(expected);
		// Only the million-character input raises the source ceiling to fit it.
		expect(seen.map(([, options]) => options ?? null)).toEqual(expected.map((_, i) => i === 3 ? { maxSourceLength: 1_000_000 } : null));
	});

	it('uses the CI seed and case count by default', async () => {
		const result = await fuzz(`export function convertCircuitikz(){throw new Error("stop");}`, []);
		expect(result.output).toContain('Fuzz seed: 6049357; cases: 20000');
		expect(result.status).toBe(1);
	});

	it('accepts the largest seed', async () => {
		const result = await fuzz(`export function convertCircuitikz(){return ${rejected(`[${error('')}]`)};}`, ['--cases=1', '--seed=4294967295']);
		expect(result.output).toContain('Fuzz seed: 4294967295; cases: 1');
		expect(result.status).toBe(0);
	});

	it.each(['--cases=0', '--cases=1000001', '--cases=1.5', '--cases=', '--cases=-1', '--seed=0', '--seed=x', '--seed=4294967296', '--seed=-1', '--seed=NaN', '--minimize-attempts=-1', '--minimize-attempts=1000001', '--minimize-attempts=x'])('rejects the out-of-range argument %s before running', async (argument) => {
		const { status, output, failure } = await fuzz('export function convertCircuitikz(){throw new Error("never called");}', [argument]);
		expect(status).toBe(1);
		expect(output).toMatch(/--(cases|seed|minimize-attempts) must be an integer from [01] through \d+/);
		expect(failure).toBeUndefined();
	});
});
