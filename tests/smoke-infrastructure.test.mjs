import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Paths from this file, not the working directory, so the suite runs from anywhere.
const repository = fileURLToPath(new URL('..', import.meta.url));
const pending = "{ok:false,source:undefined,fence:undefined,sourceMap:[],diagnostics:[{code:'unsupported',message:'Conversion is not implemented yet; this milestone validates the supported input syntax only.',line:1,column:1,endColumn:7,severity:'error'}]}";
// The topology helpers as src/topology.ts defines them, so only the clause a case breaks is wrong.
const topology = {
	canonical: "export const canonical=(nets)=>nets.filter((n)=>n.length>0).map((n)=>[...new Set(n)].sort()).sort((a,b)=>a.join('\\n')<b.join('\\n')?-1:a.join('\\n')>b.join('\\n')?1:0);",
	connectivityOf: "export const connectivityOf=(netlist)=>{const j=new Set(netlist.nodes.filter((n)=>n.kind==='junction').map((n)=>n.id));return canonical(netlist.nets.map((net)=>net.terminals.filter((t)=>!j.has(t.componentId)).map((t)=>t.componentId+'.'+t.port)));};",
	connectivityDifference: "export const connectivityDifference=(e,a)=>{const own=(nets)=>new Map(canonical(nets).flatMap((net)=>net.map((t)=>[t,net.join(', ')])));const w=own(e),f=own(a);for(const [t,n] of w){if(f.get(t)!==n)return t+' should be on {'+n+'}';}for(const t of f.keys()){if(!w.has(t))return t+' should not be connected';}return undefined;};"
};
const entry = (convert, overrides = {}) => Object.values({ ...topology, ...overrides }).join('') + `export function convertCircuitikz(t){${convert}}`;
const declarations = 'export { canonical, connectivityDifference, connectivityOf, convertCircuitikz } from "./x.js";\nexport type { CircuitConnectivity, CircuitikzConversion, CircuitikzDiagnostic, CircuitikzDiagnosticCode, CircuitikzMapping, ConvertCircuitikzOptions } from "./types.js";';
// A built package that keeps every clause: three modules, one nested and one types-only.
const good = {
	'src/index.ts': '', 'src/types.ts': '', 'src/nested/deep.ts': '',
	'dist/index.js': entry(`return ${pending};`), 'dist/index.d.ts': declarations,
	'dist/types.js': 'export {};', 'dist/types.d.ts': 'export type CircuitConnectivity = string[][];',
	'dist/nested/deep.js': 'export {};', 'dist/nested/deep.d.ts': 'export {};',
	'tests/fixtures/rejections/oversized/input.tex': 'LIMIT'
};

/** Runs the real smoke script in a scratch package whose dist is a stand-in, so a broken build can be
 * shown to fail it. The series-battery fixture and node_modules are the repository's own. */
async function smoke(files, nodeArguments = []) {
	const directory = await mkdtemp(join(tmpdir(), 'circuitikz-smoke-'));
	try {
		// A junction on Windows needs no symlink privilege; elsewhere the type is ignored.
		await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
		await cp(join(repository, 'scripts/smoke.mjs'), join(directory, 'scripts/smoke.mjs'));
		await cp(join(repository, 'tests/fixtures/conformance/series-battery'), join(directory, 'tests/fixtures/conformance/series-battery'), { recursive: true });
		await writeFile(join(directory, 'package.json'), '{"type":"module"}');
		for (const [path, text] of Object.entries({ ...good, ...files })) {
			if (text === null) continue;
			await mkdir(dirname(join(directory, path)), { recursive: true });
			await writeFile(join(directory, path), text);
		}
		const result = spawnSync(process.execPath, [...nodeArguments, 'scripts/smoke.mjs'], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
		expect(result.error).toBeUndefined();
		return { status: result.status, output: result.stdout + result.stderr };
	} finally { await rm(directory, { force: true, recursive: true }); }
}

const convert = (body) => ({ 'dist/index.js': entry(body) });
// Changes what Node.js reports about itself before the script starts.
const versions = (fields) => [`--import=data:text/javascript,Object.defineProperty(process,'versions',{value:{...process.versions,${fields}}})`];

describe('smoke infrastructure', () => {
	it('passes a built package that keeps every clause', async () => {
		const { status, output } = await smoke({});
		expect(output).toContain('a browser bundle answers 2 fixtures and the topology helpers as Node.js does, bare, as a worker and as a page.');
		expect(status).toBe(0);
	}, 30_000);

	it.each([
		{ name: 'a module with no built code', files: { 'dist/nested/deep.js': null }, error: 'dist/nested/deep.js is missing' },
		{ name: 'a module with no declarations', files: { 'dist/nested/deep.d.ts': null }, error: 'dist/nested/deep.d.ts is missing' },
		{ name: 'a module built as an empty file', files: { 'dist/nested/deep.js': '\n' }, error: 'dist/nested/deep.js is empty' },
		{ name: 'a source module added after the last build', files: { 'src/late.ts': '' }, error: 'dist/late.js is missing' },
		// The entry imports types.js only as types, so only loading each module finds these.
		{ name: 'a types module that does not parse', files: { 'dist/types.js': 'export {' }, error: 'SyntaxError' },
		{ name: 'a types module that throws on load', files: { 'dist/types.js': 'throw new Error("types broke");' }, error: 'types broke' },
		{ name: 'an entry that throws while loading', files: { 'dist/index.js': 'throw new Error("broken entry");' }, error: 'broken entry' },
		{ name: 'a public export left out', files: { 'dist/index.js': entry(`return ${pending};`).replace('export const canonical', 'const canonical') }, error: 'does not export the public API' },
		{ name: 'an extra export', files: { 'dist/index.js': `${entry(`return ${pending};`)}export const debug=1;` }, error: 'does not export the public API' },
		{ name: 'declarations that export nothing', files: { 'dist/index.d.ts': 'export {};' }, error: 'dist/index.d.ts does not declare canonical' },
		{ name: 'declarations missing a public type', files: { 'dist/index.d.ts': declarations.replace('ConvertCircuitikzOptions', '') }, error: 'does not declare ConvertCircuitikzOptions' },
		{ name: 'a converter that throws', files: convert('throw new Error("convert broke");'), error: 'convert broke' },
		{ name: 'a converter that answers otherwise', files: convert(`return {...${pending},diagnostics:[]};`), error: 'does not answer a supported circuit as the source does' },
		{ name: 'a rejection that leaves out its source key', files: convert(`const {source,...rest}=${pending};return rest;`), error: 'does not answer a supported circuit as the source does' },
		// Each topology helper is checked against values the script works out itself, never by another helper.
		{ name: 'a connectivityOf that sees no nets', files: { 'dist/index.js': entry(`return ${pending};`, { connectivityOf: 'export const connectivityOf=()=>[];' }) }, error: "connectivityOf does not read core's netlist" },
		{ name: 'a canonical that throws', files: { 'dist/index.js': entry(`return ${pending};`, { canonical: 'export const canonical=()=>{throw new Error("canonical broke");};' }) }, error: 'canonical broke' },
		{ name: 'a canonical that keeps empty nets', files: { 'dist/index.js': entry(`return ${pending};`, { canonical: topology.canonical.replace('nets.filter((n)=>n.length>0)', 'nets') }) }, error: 'canonical does not sort' },
		{ name: 'a canonical that keeps duplicates', files: { 'dist/index.js': entry(`return ${pending};`, { canonical: topology.canonical.replace('[...new Set(n)]', '[...n]') }) }, error: 'canonical does not sort' },
		{ name: 'a connectivityDifference that never finds one', files: { 'dist/index.js': entry(`return ${pending};`, { connectivityDifference: 'export const connectivityDifference=()=>undefined;' }) }, error: 'misses an unconnected terminal' },
		{ name: 'a connectivityDifference that always finds one', files: { 'dist/index.js': entry(`return ${pending};`, { connectivityDifference: "export const connectivityDifference=()=>'B1.negative';" }) }, error: 'finds a difference within one circuit' },
		// Host globals Node.js has and no browser does: each passes in Node.js and fails only in the bundle.
		{ name: 'a converter that reads process', files: convert(`process.env.HOME;return ${pending};`), error: 'process is not defined' },
		{ name: 'a converter that uses Buffer', files: convert(`Buffer.byteLength(t);return ${pending};`), error: 'Buffer is not defined' },
		{ name: 'a converter that uses global', files: convert(`global.x=1;return ${pending};`), error: 'global is not defined' },
		{ name: 'a converter that calls setImmediate', files: convert(`setImmediate(()=>{});return ${pending};`), error: 'setImmediate is not defined' },
		{ name: 'a module that reads process at load', files: { 'dist/nested/deep.js': 'export const home = process.env.HOME;', 'dist/index.js': `import './nested/deep.js';${entry(`return ${pending};`)}` }, error: 'process is not defined' },
		{ name: 'Buffer used only for a rejection fixture', files: convert(`if(t==='LIMIT')Buffer.byteLength(t);return ${pending};`), error: 'Buffer is not defined' },
		{ name: 'Buffer used only in connectivityOf', files: { 'dist/index.js': entry(`return ${pending};`, { connectivityOf: topology.connectivityOf.replace('=>{', '=>{Buffer.from("x");') }) }, error: 'Buffer is not defined' },
		{ name: 'process read only in canonical', files: { 'dist/index.js': entry(`return ${pending};`, { canonical: topology.canonical.replace('(nets)=>', '(nets)=>process.env.HOME&&') }) }, error: 'process is not defined' },
		{ name: 'a converter that touches the DOM on a page', files: convert(`if(typeof window!=='undefined')document.title;return ${pending};`), error: 'document is not defined' },
		{ name: 'a converter that answers differently without process', files: convert(`return typeof process==='undefined'?{...${pending},sourceMap:[1]}:${pending};`), error: 'in a bare context answers differently from Node.js' },
		{ name: 'a converter that answers differently in a worker', files: convert(`return typeof self!=='undefined'&&typeof window==='undefined'?{...${pending},sourceMap:[1]}:${pending};`), error: 'in a worker answers differently from Node.js' },
		{ name: 'a converter that answers differently on a page', files: convert(`return typeof window!=='undefined'?{...${pending},sourceMap:[1]}:${pending};`), error: 'in a page answers differently from Node.js' },
		{ name: 'a converter that hangs without process', files: convert(`while(typeof process==='undefined'){}return ${pending};`), error: 'Script execution timed out' },
		// Vite alone would only warn and bundle an empty stand-in for a Node.js module, and inline any installed package.
		{ name: 'a converter that imports a node: module', files: { 'dist/index.js': `import {readFileSync} from 'node:fs';${entry(`readFileSync;return ${pending};`)}` }, error: 'imports the Node.js module node:fs' },
		{ name: 'a module that imports a bare builtin', files: { 'dist/nested/deep.js': "import 'path';export {};", 'dist/index.js': `import './nested/deep.js';${entry(`return ${pending};`)}` }, error: 'imports the Node.js module path' },
		{ name: 'a module that imports a builtin subpath', files: { 'dist/nested/deep.js': "import {readFile} from 'fs/promises';export const r=readFile;", 'dist/index.js': `import './nested/deep.js';${entry(`return ${pending};`)}` }, error: 'imports the Node.js module fs/promises' },
		{ name: 'an import of a package the repository only has for its tools', files: { 'dist/index.js': `import {build} from 'vite';${entry(`build;return ${pending};`)}` }, error: 'imports vite, which is not a dependency of the package' },
		{ name: 'an import of a core subpath', files: { 'dist/index.js': `import '@schemd/core/parser';${entry(`return ${pending};`)}` }, error: 'imports @schemd/core/parser, which is not a dependency' },
		// The runtime itself.
		{ name: 'Node.js 22', files: {}, node: versions("node:'22.11.0'"), error: 'Node.js 22.11.0 is not supported' },
		{ name: 'Bun standing in for Node.js', files: {}, node: versions("bun:'1.4.4'"), error: 'Run the smoke test with Node.js, not Bun.' }
	])('fails the smoke test for $name', async ({ files, node = [], error }) => {
		const { status, output } = await smoke(files, node);
		expect(output).not.toContain('PASS');
		expect(output).toContain(error);
		expect(status).toBe(1);
	}, 30_000);

	it.each([
		{ name: 'a declaration file in src, which tsc does not emit', files: { 'src/ambient.d.ts': 'declare const x: 1;' } },
		{ name: 'a module only the entry imports, bundled into one script', files: { 'dist/nested/deep.js': 'export const message = "m";', 'dist/index.js': `import {message} from './nested/deep.js';${entry(`return message==='m'?${pending}:null;`)}` } },
		{ name: 'an import of @schemd/core', files: { 'dist/index.js': `import {parseSchematicFence} from '@schemd/core';${entry(`parseSchematicFence;return ${pending};`)}` } },
		// Core's renderer builds a TextEncoder when it loads, as every browser and worker can (M2 bundles it).
		{ name: 'Web globals every host has', files: convert(`new TextEncoder().encode(t);new URL('https://example.com');structuredClone({});queueMicrotask(()=>{});return ${pending};`) },
		{ name: 'a converter that returns a null-prototype result', files: convert(`return Object.assign(Object.create(null),${pending});`) },
		{ name: 'Node.js 24', files: {}, node: versions("node:'24.0.0'") }
	])('passes a built package with $name', async ({ files, node = [] }) => {
		const { status, output } = await smoke(files, node);
		expect(output).toContain('PASS: Node.js');
		expect(status).toBe(0);
	}, 30_000);

	it('builds before it runs, in release:check and in CI', async () => {
		const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
		expect(manifest.scripts['test:smoke']).toBe('bun run build && node scripts/smoke.mjs');
		expect(manifest.scripts['release:check']).toContain('bun run test:smoke');
		const workflow = await readFile(join(repository, '.github/workflows/ci.yml'), 'utf8');
		expect(workflow).toContain('run: bun run test:smoke');
	});
});
