/** Smoke test of the built package (R-8.6.2) and the browser half of R-2.2.2. `bun run test:smoke` builds first. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { buildNetlist, compileSchematic, parseSchematicFence } from '@schemd/core';

const root = new URL('../', import.meta.url);
// Bun reports a Node.js version too, and `bun run` stands in for a missing `node`: only Node.js counts here.
assert.equal(process.versions.bun, undefined, 'Run the smoke test with Node.js, not Bun.');
const major = Number(process.versions.node.split('.')[0]);
assert.ok(major >= 24, `Node.js ${process.versions.node} is not supported: use Node.js 24 or later.`);
// Vite itself branches on Bun when it loads, so it is imported only once the runtime is known.
const { build } = await import('vite');

const API = ['canonical', 'connectivityDifference', 'connectivityOf', 'convertCircuitikz'];
const TYPES = ['CircuitConnectivity', 'CircuitikzConversion', 'CircuitikzDiagnostic', 'CircuitikzDiagnosticCode', 'CircuitikzMapping', 'ConvertCircuitikzOptions'];

/** Every module under src, nested ones included, as a path without its extension. Declaration files are not modules (R-8.6.1). */
async function modules(directory, prefix = '') {
	const names = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) names.push(...await modules(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`));
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) names.push(`${prefix}${entry.name.slice(0, -'.ts'.length)}`);
	}
	return names;
}

// Every module was built, as code and as declarations, and every built module loads: the entry
// imports some only as types, and a consumer can still import them through an exports subpath.
for (const name of await modules(new URL('src/', root))) {
	for (const extension of ['.js', '.d.ts']) {
		const path = `dist/${name}${extension}`;
		const text = await readFile(new URL(path, root), 'utf8').catch(() => assert.fail(`${path} is missing: run bun run build.`));
		assert.ok(text.trim().length > 0, `${path} is empty.`);
	}
	await import(new URL(`dist/${name}.js`, root).href);
}

// The entry exports exactly the public API, and its declarations name every export and public type.
const converter = await import(new URL('dist/index.js', root).href);
assert.deepEqual(Object.keys(converter).sort(), API, 'dist/index.js does not export the public API.');
const declarations = await readFile(new URL('dist/index.d.ts', root), 'utf8');
for (const name of [...API, ...TYPES]) assert.match(declarations, new RegExp(`\\b${name}\\b`), `dist/index.d.ts does not declare ${name}.`);

/** Every fixture input, conformance and rejections alike: each folder that holds an input.tex. */
async function inputs() {
	const found = [];
	for (const kind of ['conformance', 'rejections']) {
		const directory = new URL(`tests/fixtures/${kind}/`, root);
		const folders = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
		for (const name of folders) {
			const path = new URL(`${name}/input.tex`, directory);
			if (existsSync(path)) found.push({ name: `${kind}/${name}`, input: await readFile(path, 'utf8') });
		}
	}
	return found;
}

const fixture = (file) => readFile(new URL(`tests/fixtures/conformance/series-battery/${file}`, root), 'utf8');
const meta = JSON.parse(await fixture('meta.json'));
const data = {
	inputs: await inputs(),
	netlist: buildNetlist(compileSchematic(await fixture('expected.schemd'), parseSchematicFence(meta.fence)).document),
	connectivity: meta.connectivity
};

/* Calls every export on the same data. Runs as is in Node.js and, as source text, in each browser
   context below, so it may use nothing but the language and its argument. */
function exercise(api, { inputs, netlist, connectivity }) {
	// The nets reversed, each one reversed with its first terminal repeated, after an empty net.
	const scrambled = [[], ...connectivity.map((net) => [...net].reverse().concat(net[0])).reverse()];
	return {
		conversions: inputs.map(({ name, input }) => [name, api.convertCircuitikz(input)]),
		connectivity: api.connectivityOf(netlist),
		canonical: api.canonical(scrambled),
		same: api.connectivityDifference(connectivity, api.connectivityOf(netlist)),
		missing: api.connectivityDifference(connectivity, [])
	};
}

// What Node.js answers, checked against values worked out here rather than by the build's own helpers.
const node = structuredClone(exercise(converter, data));
const byCodeUnit = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const expected = meta.connectivity.map((net) => [...net].sort(byCodeUnit)).sort((a, b) => byCodeUnit(a.join('\n'), b.join('\n')));
// Until M2 a supported circuit gets the pending diagnostic over the environment; from M2 on, it converts (R-8.6.2).
assert.deepEqual(Object.fromEntries(node.conversions)['conformance/series-battery'], {
	ok: false, source: undefined, fence: undefined, sourceMap: [],
	diagnostics: [{ code: 'unsupported', message: 'Conversion is not implemented yet; this milestone validates the supported input syntax only.', line: 1, column: 1, endColumn: 7, severity: 'error' }]
}, 'The built converter does not answer a supported circuit as the source does.');
assert.deepEqual(node.connectivity, expected, 'The built connectivityOf does not read core\'s netlist as the TeX wires it.');
assert.deepEqual(node.canonical, expected, 'The built canonical does not sort, deduplicate and drop empty nets.');
assert.equal(node.same, undefined, 'The built connectivityDifference finds a difference within one circuit.');
assert.ok(typeof node.missing === 'string' && node.missing.includes(expected[0][0]), 'The built connectivityDifference misses an unconnected terminal.');

/* Browser and worker hosts: bundle the entry as one script and run it in fresh V8 contexts that have
   the Web globals every host shares and none of Node.js's own (process, Buffer, require, global,
   setImmediate): bare, as a worker (self), and as a page (window and self). Each must answer as
   Node.js did. Vite would only warn and swap an import of a Node.js module for an empty one, and
   would inline any package the repository happens to have installed, so dist may import only
   @schemd/core and its own files. */
const dist = fileURLToPath(new URL('dist/', root));
const bundled = await build({
	configFile: false, logLevel: 'silent',
	plugins: [{
		name: 'refuse-host-modules', enforce: 'pre',
		resolveId(id, importer) {
			if (id.startsWith('node:') || builtinModules.includes(id)) throw new Error(`${importer ?? 'dist'} imports the Node.js module ${id}, which a browser or worker does not have.`);
			if (importer?.startsWith(dist) && !/^[./\0]/.test(id) && id !== '@schemd/core') throw new Error(`${importer} imports ${id}, which is not a dependency of the package.`);
		}
	}],
	build: { write: false, target: 'es2022', minify: false, lib: { entry: fileURLToPath(new URL('dist/index.js', root)), formats: ['iife'], name: 'Circuitikz' } }
});
// An iife build cannot split into chunks, so its one chunk is the whole script.
const [script] = (Array.isArray(bundled) ? bundled.flatMap((item) => item.output) : bundled.output).filter((item) => item.type === 'chunk');
const WEB = ['TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'structuredClone', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'atob', 'btoa'];
for (const [host, setup] of [['a bare context', ''], ['a worker', 'globalThis.self = globalThis;'], ['a page', 'globalThis.self = globalThis.window = globalThis;']]) {
	const context = createContext(Object.fromEntries(WEB.map((name) => [name, globalThis[name]])));
	context.data = data;
	runInContext(`${setup}\n${script.code}\nresult = (${exercise})(Circuitikz, data);`, context, { timeout: 2000 });
	assert.deepEqual(structuredClone(context.result), node, `The browser bundle in ${host} answers differently from Node.js.`);
}

console.log(`PASS: Node.js ${process.versions.node} loads every built module, which export and declare the public API; a browser bundle answers ${data.inputs.length} fixtures and the topology helpers as Node.js does, bare, as a worker and as a page.`);
