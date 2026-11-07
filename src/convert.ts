import { resolveCoordinates } from './coordinates.js';
import { Diagnostics, limit, pending, presentation, unsupported } from './diagnostics.js';
import { scan } from './lexer.js';
import { optionsOf } from './options.js';
import { parse } from './parser.js';
import type { Key } from './ast.js';
import type { CircuitikzConversion, ConvertCircuitikzOptions } from './types.js';

/** Only keys explicitly listed in R-4.4.2 can be ignored with a warning. */
function keysOf(keys: readonly Key[], diagnostics: Diagnostics, environment: boolean): void {
	for (const key of keys) {
		if (environment && key.name === 'fixbatteries' && key.value === undefined) continue;
		if (['mirror', 'thick', 'thin', 'dashed', '-*', '*-', '*-*', '-o', 'o-', 'o-o'].includes(key.name) && key.value === undefined
			|| ['color', 'line width'].includes(key.name) && key.value !== undefined) presentation(diagnostics, key.name, key.span);
		else unsupported(diagnostics, `Option ${key.name}`, key.span);
	}
}

/**
 * Validate the M1 CircuiTikZ syntax without emitting partial Schemd source.
 * Until M2, a syntactically supported input receives the documented pending diagnostic.
 * Invalid host arguments throw TypeError; malformed TeX is reported in diagnostics.
 */
export function convertCircuitikz(source: string, options?: ConvertCircuitikzOptions): CircuitikzConversion {
	if (typeof source !== 'string') throw new TypeError('source must be a string containing one circuitikz environment.');
	const settings = optionsOf(options);
	const diagnostics = new Diagnostics(settings.strict);
	if (source.length > settings.maxSourceLength) {
		limit(diagnostics, 'source length', settings.maxSourceLength, 'convert a shorter document', { start: 0, end: 0, line: 1, column: 1, endColumn: 1 });
	} else {
		const tokens = scan(source, diagnostics);
		if (diagnostics.items.length === 0) {
			const tree = parse(tokens, diagnostics, (keys, environment) => keysOf(keys, diagnostics, environment));
			if (tree !== undefined) {
				resolveCoordinates(tree, diagnostics);
				if (!diagnostics.items.some((item) => item.severity === 'error')) pending(diagnostics, tree.span);
			}
		}
	}
	return { ok: false, source: undefined, fence: undefined, sourceMap: [], diagnostics: diagnostics.sorted() };
}
