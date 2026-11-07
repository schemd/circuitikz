/**
 * What a host pays to ship the converter, over and above `@schemd/core`.
 *
 * The whole public entry is bundled with nothing shaken away — what registry
 * size tools report, because they bundle `import * from '@schemd/circuitikz'`
 * — and `@schemd/core` is left external, because the host already ships it and
 * this package only peers on it.
 *
 * A budget moves only in the pull request whose code moves it, with a comment
 * here saying what paid for the bytes, measured against the build before it,
 * as `@schemd/core` records its own. REQUIREMENTS.md §8.5 sets the ceiling the
 * 0.1.0 release must fit under.
 */
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const BUDGETS = [
	{
		label: 'Package bundle (every public export, @schemd/core external)',
		module: '../src/index.ts',
		entry: (path) => `import * as converter from ${JSON.stringify(path)};globalThis.schemdCircuitikz=converter;`,
		/* M1's budget from R-8.5.4. 0.0.0 measured 538 B gzip / 455 B brotli. The
		   parser, coordinate literals, host options and convertCircuitikz measured
		   4186 B gzip / 3716 B brotli; with the coordinate resolver, 4705 B / 4206 B. */
		maxGzipBytes: 5 * 1024,
		maxBrotliBytes: 5 * 1024
	}
];

const virtualEntry = 'virtual:schemd-circuitikz-size-entry';

/** Bundle one entry and return its minified, gzip and brotli byte counts. */
async function measure({ module, entry }) {
	const modulePath = fileURLToPath(new URL(module, import.meta.url));
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		plugins: [
			{
				name: 'schemd-circuitikz-size-entry',
				enforce: 'pre',
				resolveId(id) {
					if (id === virtualEntry) return `\0${virtualEntry}`;
				},
				load(id) {
					if (id === `\0${virtualEntry}`) return entry(modulePath);
				}
			}
		],
		build: {
			minify: true,
			rollupOptions: { input: virtualEntry, treeshake: true, external: [/^@schemd\/core(?:\/|$)/] },
			target: 'es2022',
			write: false
		}
	});

	const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
	const chunks = outputs.filter((item) => item.type === 'chunk' && item.code.length > 0);
	if (chunks.length !== 1) throw new Error(`Expected one chunk; received ${chunks.length}.`);
	return {
		minifiedBytes: Buffer.byteLength(chunks[0].code),
		gzipBytes: gzipSync(chunks[0].code, { level: 9 }).byteLength,
		brotliBytes: brotliCompressSync(chunks[0].code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength
	};
}

const format = (bytes) => `${bytes.toLocaleString('en-US')} B`;
const failures = [];
for (const budget of BUDGETS) {
	const { minifiedBytes, gzipBytes, brotliBytes } = await measure(budget);
	console.log(
		`${budget.label}: ${format(minifiedBytes)} minified, ${format(brotliBytes)} brotli-11 (budget ${format(budget.maxBrotliBytes)}), ` +
			`${format(gzipBytes)} gzip (budget ${format(budget.maxGzipBytes)})`
	);
	if (gzipBytes > budget.maxGzipBytes) failures.push(`${budget.label} exceeds its gzip budget by ${format(gzipBytes - budget.maxGzipBytes)}.`);
	if (brotliBytes > budget.maxBrotliBytes) failures.push(`${budget.label} exceeds its brotli-11 budget by ${format(brotliBytes - budget.maxBrotliBytes)}.`);
}

if (failures.length > 0) throw new Error(failures.join('\n'));
