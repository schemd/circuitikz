import { resolveCoordinates } from './coordinates.js';
import { Diagnostics, limit, pending, unsupported } from './diagnostics.js';
import { partOf, presentationKey } from './components.js';
import { buildCircuit } from './graph.js';
import { scan } from './lexer.js';
import { optionsOf } from './options.js';
import { parse } from './parser.js';
import type { Key, ResolvedSegment } from './ast.js';
import type { Segment } from './circuit.js';
import type { CircuitikzConversion, ConvertCircuitikzOptions } from './types.js';

/** Only keys explicitly listed in R-4.4.2 can be ignored with a warning. */
function keysOf(keys: readonly Key[], diagnostics: Diagnostics, environment: boolean): void {
	for (const key of keys) {
		if (environment && key.name === 'fixbatteries' && key.value === undefined) continue;
		if (!presentationKey(key, diagnostics)) unsupported(diagnostics, `Option ${key.name}`, key.span);
	}
}

/** Give each to[...] its part, and split |- and -| at their corner, which is a vertex of the graph (R-4.3.2). */
export function segmentsOf(resolved: readonly ResolvedSegment[], source: string, fixBatteries: boolean, diagnostics: Diagnostics): Segment[] {
	const segments: Segment[] = [];
	for (const segment of resolved) {
		const spec = segment.operation === 'to' ? partOf(segment.keys, source, fixBatteries, segment.span, diagnostics) : undefined;
		if (segment.operation === '|-' || segment.operation === '-|') {
			const corner = segment.operation === '|-' ? { x: segment.from.x, y: segment.to.y } : { x: segment.to.x, y: segment.from.y };
			segments.push({ ...segment, to: corner, toSpan: segment.span, spec });
			segments.push({ ...segment, from: corner, fromSpan: segment.span, spec });
		} else segments.push({ ...segment, spec });
	}
	return segments;
}

/**
 * Validate the CircuiTikZ syntax and build the circuit graph without emitting partial Schemd source.
 * Until the emitter lands, an input with no error receives the documented pending diagnostic.
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
				const fixBatteries = tree.keys.some((key) => key.name === 'fixbatteries' && key.value === undefined);
				const segments = segmentsOf(resolveCoordinates(tree, diagnostics), source, fixBatteries, diagnostics);
				// The graph is built only from a path that resolved and parsed cleanly, so its findings are never cascades.
				if (!diagnostics.items.some((item) => item.severity === 'error')) buildCircuit(segments, tree.span, diagnostics);
				if (!diagnostics.items.some((item) => item.severity === 'error')) pending(diagnostics, tree.span);
			}
		}
	}
	return { ok: false, source: undefined, fence: undefined, sourceMap: [], diagnostics: diagnostics.sorted() };
}
