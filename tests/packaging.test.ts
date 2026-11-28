/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

import manifest from '../package.json';

/**
 * The package's public surface and its dependency contract.
 *
 * A module is either public — an `exports` subpath, documented, supported — or
 * listed here as internal. There is no third state: `@schemd/core` twice
 * shipped a module in the tarball that could not be imported because it had
 * no `exports` entry, and every test passed because tests import from `src`.
 *
 * If unsure, a module is internal. Promoting later is easy; un-promoting is a
 * breaking change.
 */
const INTERNAL_MODULES = new Set(['ast', 'circuit', 'components', 'convert', 'coordinates', 'diagnostics', 'graph', 'labels', 'lexer', 'limits', 'options', 'parser', 'topology']);

type Entry = { types?: string; import?: string };
const exportsMap = manifest.exports as Record<string, Entry>;

/* Every source file by its path under `src`, without `.ts`: `index`, `parts/index`. */
const sourceFiles = Object.keys(import.meta.glob(['../src/**/*.ts', '!../src/**/*.d.ts']))
	.map((path) => path.replace('../src/', '').replace(/\.ts$/, ''))
	.sort();

/* The source file each subpath, `.` included, resolves to. */
const exportedFiles = new Map(Object.entries(exportsMap).map(([subpath, entry]) => [subpath, (entry.import ?? '').replace(/^\.\/dist\//, '').replace(/\.js$/, '')]));

/**
 * Source files neither exported nor internal. Files are compared by path, never
 * by a normalized name, so `src/parts.ts` beside `src/parts/index.ts`, or
 * `src/index/index.ts` beside `src/index.ts`, cannot hide behind each other.
 */
const unclassified = (files: readonly string[], exported: ReadonlySet<string>, internal: ReadonlySet<string>) =>
	files.filter((file) => !exported.has(file) && !internal.has(file));

describe('package exports', () => {
	it('finds the source modules it is meant to police', () => {
		expect(sourceFiles).toContain('index');
		expect(sourceFiles).toContain('types');
	});

	it('gives every public source module an importable subpath', () => {
		const missing = unclassified(sourceFiles, new Set(exportedFiles.values()), INTERNAL_MODULES);
		expect(missing, `public modules with no exports entry: ${missing.join(', ')}`).toEqual([]);
	});

	it('keeps a flat file and a directory index of the same name apart', () => {
		/* Review on #4: each of these once merged into one name and slipped through. */
		expect(unclassified(['index', 'index/index'], new Set(['index']), new Set())).toEqual(['index/index']);
		expect(unclassified(['parts', 'parts/index'], new Set(['parts/index']), new Set())).toEqual(['parts']);
		expect(unclassified(['parts', 'parts/index'], new Set(['parts']), new Set(['parts/index']))).toEqual([]);
	});

	it('classifies a module as public or internal, never both', () => {
		expect([...exportedFiles.values()].filter((file) => INTERNAL_MODULES.has(file))).toEqual([]);
	});

	it('lists no internal module that does not exist', () => {
		const stale = [...INTERNAL_MODULES].filter((module) => !sourceFiles.includes(module));
		expect(stale, `INTERNAL_MODULES names missing modules: ${stale.join(', ')}`).toEqual([]);
	});

	it('points every subpath at the module it names', () => {
		/* `src/index.ts` is the `.` entry; `./parts` may be `src/parts.ts` or `src/parts/index.ts`. */
		for (const [subpath, file] of exportedFiles) {
			const name = subpath === '.' ? 'index' : subpath.replace('./', '');
			expect([name, `${name}/index`], `${subpath} points at the wrong module`).toContain(file);
			expect(exportsMap[subpath]!.types, `${subpath} types point at the wrong module`).toBe(`./dist/${file}.d.ts`);
		}
	});

	it('exports no subpath without a source module behind it', () => {
		const orphans = [...exportedFiles].filter(([, file]) => !sourceFiles.includes(file)).map(([subpath]) => subpath);
		expect(orphans, `subpaths with no source module: ${orphans.join(', ')}`).toEqual([]);
	});

	it('ships the directory every subpath resolves into, and nothing else of ours', () => {
		expect(manifest.files).toEqual(['dist', 'README.md', 'CHANGELOG.md']);
		expect(manifest.exports['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' });
		expect(manifest.type).toBe('module');
		expect(manifest.sideEffects).toBe(false);
	});
});

describe('dependency contract', () => {
	it('has no runtime dependencies', () => {
		/* The converter's only runtime need is the compiler it targets, and the
		   host already has that — so it is a peer, never a dependency. */
		expect(manifest).not.toHaveProperty('dependencies');
		expect(manifest).not.toHaveProperty('optionalDependencies');
		expect(manifest).not.toHaveProperty('bundleDependencies');
	});

	it('peers on @schemd/core alone, and tests against the same range', () => {
		expect(manifest.peerDependencies).toEqual({ '@schemd/core': manifest.devDependencies['@schemd/core'] });
		expect(manifest.peerDependencies['@schemd/core']).toMatch(/^\^1\.\d+\.\d+$/);
	});

	it('supports the Node.js line @schemd/core supports', () => {
		expect(manifest.engines).toEqual({ node: '>=24' });
	});
});
