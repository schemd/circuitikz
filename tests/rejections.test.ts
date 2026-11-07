/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

import { convertCircuitikz } from '../src/index.js';
import type { CircuitikzDiagnostic, ConvertCircuitikzOptions } from '../src/types.js';

const files = (values: Record<string, unknown>) => new Map(Object.entries(values).map(([path, value]) => [path.split('/').at(-2)!, value]));
const inputs = files(import.meta.glob('./fixtures/rejections/*/input.tex', { query: '?raw', import: 'default', eager: true }));
const expected = files(import.meta.glob('./fixtures/rejections/*/expected.json', { import: 'default', eager: true }));
const options = files(import.meta.glob('./fixtures/rejections/*/options.json', { import: 'default', eager: true }));
const cases = [...inputs.keys()].sort();

describe('rejection corpus', () => {
	it('requires input and complete diagnostics for every case', () => {
		expect(cases).toHaveLength(45);
		expect([...expected.keys()].sort()).toEqual(cases);
		expect([...options.keys()].every((key) => inputs.has(key))).toBe(true);
	});

	it.each(cases)('%s preserves the entire diagnostic and rejects without partial source', (name) => {
		const diagnostics = expected.get(name) as CircuitikzDiagnostic[];
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(convertCircuitikz(inputs.get(name) as string, options.get(name) as ConvertCircuitikzOptions | undefined)).toEqual({
			ok: false, source: undefined, fence: undefined, sourceMap: [], diagnostics
		});
	});
});
