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
const INTERNAL_MODULES = new Set(['topology']);

/* `src/index.ts` is the `.` entry; `src/parts/index.ts` would be the `./parts` subpath. */
const moduleName = (file: string) => (file === 'index' ? file : file.replace(/\/index$/, ''));

const sourceFiles = new Map(
	Object.keys(import.meta.glob('../src/**/*.ts')).map((path) => {
		const file = path.replace('../src/', '').replace(/\.ts$/, '');
		return [moduleName(file), file] as const;
	})
);
const sourceModules = [...sourceFiles.keys()].sort();

const subpaths = Object.keys(manifest.exports).filter((key) => key !== '.');
const exportedModules = new Set(subpaths.map((key) => key.replace('./', '')));
const publicModules = new Set(['index', ...exportedModules]);

describe('package exports', () => {
	it('finds the source modules it is meant to police', () => {
		expect(sourceModules).toContain('index');
		expect(sourceModules).toContain('types');
	});

	it('gives every public source module an importable subpath', () => {
		const missing = sourceModules.filter((module) => !INTERNAL_MODULES.has(module) && !publicModules.has(module));
		expect(missing, `public modules with no exports entry: ${missing.join(', ')}`).toEqual([]);
	});

	it('names a nested index module after its directory, as its subpath does', () => {
		expect(['index', 'types', 'parts/index', 'parts/battery'].map(moduleName)).toEqual(['index', 'types', 'parts', 'parts/battery']);
	});

	it('classifies a module as public or internal, never both', () => {
		expect([...publicModules].filter((module) => INTERNAL_MODULES.has(module))).toEqual([]);
	});

	it('lists no internal module that does not exist', () => {
		const stale = [...INTERNAL_MODULES].filter((module) => !sourceModules.includes(module));
		expect(stale, `INTERNAL_MODULES names missing modules: ${stale.join(', ')}`).toEqual([]);
	});

	it('points every subpath at the module it names', () => {
		for (const subpath of subpaths) {
			const name = subpath.replace('./', '');
			const entry = (manifest.exports as Record<string, { types?: string; import?: string }>)[subpath]!;
			const file = sourceFiles.get(name) ?? name;
			expect(entry.import, `${subpath} points at the wrong module`).toBe(`./dist/${file}.js`);
			expect(entry.types, `${subpath} types point at the wrong module`).toBe(`./dist/${file}.d.ts`);
		}
	});

	it('exports no subpath without a source module behind it', () => {
		const orphans = [...exportedModules].filter((name) => !sourceModules.includes(name));
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
