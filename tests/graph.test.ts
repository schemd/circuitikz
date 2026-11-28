/// <reference types="vite/client" />
import { SCHEMATIC_LIMITS, parseSchematicFence } from '@schemd/core';
import { describe, expect, it } from 'vitest';

import { convertCircuitikz, canonical } from '../src/index.js';
import { segmentsOf } from '../src/convert.js';
import { resolveCoordinates } from '../src/coordinates.js';
import { Diagnostics } from '../src/diagnostics.js';
import { buildCircuit } from '../src/graph.js';
import { scan } from '../src/lexer.js';
import { LIMITS, MARGIN } from '../src/limits.js';
import { parse } from '../src/parser.js';
import type { Circuit, Segment } from '../src/circuit.js';
import type { CircuitikzDiagnostic } from '../src/types.js';

/**
 * The circuit graph (R-5.1, R-5.2), checked without the emitter: against the
 * conformance corpus, whose expected documents were written by hand, against
 * an independent brute-force model on random circuits, and case by case at
 * every boundary the requirements name.
 */

const wrap = (body: string, env = '') => `\\begin{circuitikz}${env}\n${body}\n\\end{circuitikz}`;

/** The same front end convert runs, stopping at the graph. */
function graphOf(source: string): { circuit: Circuit | undefined; diagnostics: CircuitikzDiagnostic[] } {
	const d = new Diagnostics(false);
	const tree = parse(scan(source, d), d);
	expect(tree, source).toBeDefined();
	const fix = tree!.keys.some((key) => key.name === 'fixbatteries' && key.value === undefined);
	const segments = segmentsOf(resolveCoordinates(tree!, d), source, fix, d);
	expect(d.sorted(), source).toEqual([]);
	return { circuit: buildCircuit(segments, tree!.span, d), diagnostics: d.sorted() };
}
const accepted = (body: string, env = '') => {
	const { circuit, diagnostics } = graphOf(wrap(body, env));
	expect(diagnostics, body).toEqual([]);
	return circuit!;
};
const messages = (body: string) => graphOf(wrap(body)).diagnostics.map((d) => d.message);
const edges = (circuit: Circuit) => circuit.connections.map(({ from, to, color }) => `${from} -> ${to} #${color}`);

const OVERLAP = 'Segments overlap along their length; separate them or join them at explicit endpoints.';
const DEAD_END = 'A wire with an unconnected end is not supported; use the documented CircuiTikZ subset instead.';
const ORPHAN = 'A wire connected to nothing is not supported; use the documented CircuiTikZ subset instead.';
const EMPTY = 'A circuit without components or junctions is not supported; use the documented CircuiTikZ subset instead.';
const interior = (x: number, y: number) =>
	`Endpoint (${x},${y}) lies inside another segment (hundredths of a TikZ unit), which makes no connection; split that segment at the point or move the endpoint.`;
const geometry = (from: string, to: string, reason: string) =>
	`Component segment ${from} to ${to} ${reason} (endpoints in hundredths of a TikZ unit); use an axis-aligned segment at least 0.84 TikZ units long.`;

describe('the conformance corpus, read back from the graph', () => {
	const read = (pattern: Record<string, unknown>) => new Map(Object.entries(pattern).map(([path, value]) => [path.split('/').at(-2)!, value]));
	const inputs = read(import.meta.glob('./fixtures/conformance/*/input.tex', { query: '?raw', import: 'default', eager: true }));
	const outputs = read(import.meta.glob('./fixtures/conformance/*/expected.schemd', { query: '?raw', import: 'default', eager: true }));
	const metas = read(import.meta.glob('./fixtures/conformance/*/meta.json', { import: 'default', eager: true }));
	const cases = [...inputs.keys()].sort();

	it('finds every case', () => {
		expect(cases).toEqual(['coordinate-forms', 'cycle-return', 'divider-junctions', 'series-battery']);
	});

	describe.each(cases)('%s', (name) => {
		const { circuit, diagnostics } = graphOf(inputs.get(name) as string);
		const lines = (outputs.get(name) as string).trimEnd().split('\n');
		const meta = metas.get(name) as { fence: string; connectivity: string[][] };
		const declared = lines.map((line) => /^(\w+):(\w+) "([^"]*)" at \((\d+), (\d+)\)/.exec(line)).filter((m) => m !== null);

		it('builds without a diagnostic', () => expect(diagnostics).toEqual([]));

		it('expects the nets meta.json was written with', () => {
			expect(circuit!.expected).toEqual(canonical(meta.connectivity));
		});

		it('numbers the parts and junctions the document declares, in order', () => {
			const kinds = { source: 'source', resistor: 'resistor', capacitor: 'capacitor', inductor: 'inductor' } as Record<string, string>;
			expect(circuit!.parts.map((p) => [kinds[p.spec.kind], p.id, p.spec.label ?? p.id]))
				.toEqual(declared.filter((m) => m[1] !== 'junction').map((m) => [m[1], m[2], m[3]]));
			expect(circuit!.junctions.map((j) => j.id)).toEqual(declared.filter((m) => m[1] === 'junction').map((m) => m[2]));
		});

		it('emits the connections the document lists, in order, direction and colour', () => {
			expect(edges(circuit!)).toEqual(lines.filter((line) => line.includes(' -> ')).map((line) => line.replace(' [ortho]', '')));
		});

		it('measures the fence the document was drawn in, and places junctions in it', () => {
			const { width, height } = circuit!.bounds;
			expect({ width, height }).toEqual(parseSchematicFence(meta.fence)!.bounds);
			for (const junction of circuit!.junctions) {
				const v = circuit!.vertices[junction.vertex]!;
				const m = declared.find((d) => d[2] === junction.id)!;
				expect([v.x - circuit!.bounds.minX + MARGIN, circuit!.bounds.maxY - v.y + MARGIN]).toEqual([Number(m[4]), Number(m[5])]);
			}
		});
	});
});

describe('convert runs every input through the graph', () => {
	it.each([
		['\\draw (0,0) to[R] (1,1);', geometry('(0,0)', '(100,100)', 'is diagonal')],
		['\\draw (0,0) -- (2,0);\\draw (1,0) -- (3,0);', OVERLAP],
		['\\draw (0,0) -- (2,0);', EMPTY]
	])('reports what the graph finds in %s, without the pending diagnostic', (body, message) => {
		const result = convertCircuitikz(wrap(body));
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => d.message)).toContain(message);
		expect(result.diagnostics.map((d) => d.message)).not.toContain('Conversion is not implemented yet; this milestone validates the supported input syntax only.');
	});

	it('gives a circuit the graph accepts the pending diagnostic, and only that', () => {
		for (const body of ['\\draw (0,0) to[R] (2,0);', '\\draw (0,0) to[R] (2,0) -- (2,2) to[C] (0,2) -- (0,0);']) {
			expect(convertCircuitikz(wrap(body)).diagnostics).toEqual([{ code: 'unsupported', severity: 'error',
				message: 'Conversion is not implemented yet; this milestone validates the supported input syntax only.', line: 1, column: 1, endColumn: 7 }]);
		}
	});

	it('builds no graph from a path with an earlier error, so its findings never cascade', () => {
		// The undefined name drops the R segment; a graph built anyway would also call the wire an orphan.
		expect(convertCircuitikz(wrap('\\draw (Q) to[R] (2,0) -- (4,0);')).diagnostics.map((d) => d.code)).toEqual(['reference']);
		expect(convertCircuitikz(wrap('\\draw (0,0) to[R,scale=2] (1,1);')).diagnostics.map((d) => d.code)).toEqual(['unsupported']);
	});

	it('still builds the graph after a presentation warning, and stops when strict makes it an error', () => {
		const input = wrap('\\draw[thick] (0,0) to[R] (2,0);');
		expect(convertCircuitikz(input).diagnostics.map((d) => [d.severity, d.message])).toEqual([
			['error', 'Conversion is not implemented yet; this milestone validates the supported input syntax only.'],
			['warning', 'Presentation option thick was ignored; schemd draws its own style.']]);
		expect(convertCircuitikz(input, { strict: true }).diagnostics.map((d) => d.severity)).toEqual(['error']);
	});
});

describe('vertices and nets (R-5.1.1 to R-5.1.3)', () => {
	it('joins two points exactly when their integer coordinates are equal', () => {
		expect(accepted('\\draw (0,0) to[R] (2,0);\\draw (2,0) to[C] (4,0);').expected).toEqual([['C1.in', 'R1.out'], ['C1.out'], ['R1.in']]);
		expect(accepted('\\draw (0,0) to[R] (2,0);\\draw (2.01,0) to[C] (4,0);').expected).toEqual([['C1.in'], ['C1.out'], ['R1.in'], ['R1.out']]);
		expect(accepted('\\draw (0,0) to[R] (2,0);\\draw (2cm,0cm) to[C] (4,0);').expected).toEqual([['C1.in', 'R1.out'], ['C1.out'], ['R1.in']]);
	});

	it('keeps both terminals of a lone part as singleton nets', () => {
		expect(accepted('\\draw (0,0) to[R] (2,0);').expected).toEqual([['R1.in'], ['R1.out']]);
	});

	it('lets components split nets and wires join them', () => {
		const c = accepted('\\draw (0,0) to[R] (2,0) to[C] (4,0) to[L] (6,0);');
		expect(c.expected).toEqual([['C1.in', 'R1.out'], ['C1.out', 'L1.in'], ['L1.out'], ['R1.in']]);
		expect(accepted('\\draw (0,0) to[R] (2,0) -- (2,2) to[C] (4,2);').expected).toEqual([['C1.in', 'R1.out'], ['C1.out'], ['R1.in']]);
	});

	it('joins a component to itself through a wire loop', () => {
		expect(accepted('\\draw (0,0) to[R] (2,0) -- (2,2) -- (0,2) -- (0,0);').expected).toEqual([['R1.in', 'R1.out']]);
	});

	it('treats to[short] as a wire, never a part', () => {
		const c = accepted('\\draw (0,0) to[R] (2,0) to[short] (4,0) to[C] (6,0);');
		expect(c.parts.map((p) => p.id)).toEqual(['R1', 'C1']);
		expect(c.expected).toEqual([['C1.in', 'R1.out'], ['C1.out'], ['R1.in']]);
		expect(edges(c)).toEqual(['R1.out -> C1.in #amber']);
	});

	it('never connects crossing wires that share no vertex', () => {
		const c = accepted('\\draw (-2,0) to[R] (0,0) -- (4,0) to[C] (6,0);\\draw (2,-4) to[L] (2,-2) -- (2,2) to[R] (2,4);');
		expect(c.expected).toEqual(canonical([['R1.in'], ['R1.out', 'C1.in'], ['C1.out'], ['L1.in'], ['L1.out', 'R2.in'], ['R2.out']]));
		expect(c.junctions).toEqual([]);
	});

	it('never connects crossing diagonal wires either', () => {
		const c = accepted('\\draw (0,0) to[R] (0,2) -- (4,6) to[C] (6,6);\\draw (0,6) to[L] (0,8) -- (4,2) to[R] (6,2);');
		expect(c.expected).toHaveLength(6);
		expect(c.junctions).toEqual([]);
	});

	it('splits |- and -| at their corner, which joins only through a real shared point', () => {
		expect(accepted('\\draw (0,0) to[R] (2,0) |- (4,2) to[C] (6,2);').expected).toEqual([['C1.in', 'R1.out'], ['C1.out'], ['R1.in']]);
		expect(accepted('\\draw (0,0) to[R] (2,0) -| (4,2) to[C] (4,4);').expected).toEqual([['C1.in', 'R1.out'], ['C1.out'], ['R1.in']]);
		// The corner of |- from (2,0) to (4,2) is (2,2): a part ending there shares it.
		const c = accepted('\\draw (0,0) to[R] (2,0) |- (4,2) to[C] (6,2);\\draw (2,2) to[L] (2,4);');
		expect(c.junctions.map((j) => c.vertices[j.vertex]).map((v) => [v!.x, v!.y])).toEqual([[200, 200]]);
		expect(c.expected).toContainEqual(['C1.in', 'L1.in', 'R1.out']);
	});

	it.each([['|-', '(2,2)', '(4,2)'], ['-|', '(4,0)', '(4,2)']])('keeps the zero-length leg of %s out of the degree count', (op, corner, end) => {
		// From (2,0), |- (2,2) and -| (4,0) each have a second leg of length zero at the target.
		const c = accepted(`\\draw (0,0) to[R] (2,0) ${op} ${corner} to[C] ${end};`);
		expect(c.junctions).toEqual([]);
		expect(c.expected).toContainEqual(['C1.in', 'R1.out']);
	});

	it('discards a zero-length wire, which adds no branch, junction or dead end', () => {
		for (const body of ['\\draw (0,0) to[R] (2,0) -- (2,0);', '\\draw (0,0) to[R] (2,0) -- (2,0) -- (2,0) to[C] (4,0);', '\\draw (2,0) -- (2,0);\\draw (0,0) to[R] (2,0) to[C] (4,0);']) {
			const c = accepted(body);
			expect(c.junctions, body).toEqual([]);
			expect(c.connections.every((k) => k.from !== k.to), body).toBe(true);
		}
	});
});

describe('junctions (R-5.1.4)', () => {
	it.each([
		['three parts meeting', '\\draw (0,0) to[R] (2,0);\\draw (2,0) to[C] (4,0);\\draw (2,0) to[L] (2,2);', 1],
		['four parts meeting', '\\draw (0,0) to[R] (2,0);\\draw (2,0) to[C] (4,0);\\draw (2,0) to[L] (2,2);\\draw (2,0) to[R] (2,-2);', 1],
		['a wire tee', '\\draw (0,0) to[R] (2,0) -- (4,0) to[C] (6,0);\\draw (4,0) -- (4,2) to[L] (6,2);', 1],
		['two parts and a corner', '\\draw (0,0) to[R] (2,0) -- (2,2) to[C] (4,2);', 0],
		['a straight wire through a point', '\\draw (0,0) to[R] (2,0) -- (4,0) -- (6,0) to[C] (8,0);', 0]
	])('%s', (_, body, count) => {
		expect(accepted(body).junctions).toHaveLength(count);
	});

	it('numbers junctions in the order their vertex first appears', () => {
		const c = accepted('\\draw (4,0) to[R] (6,0);\\draw (0,0) to[C] (2,0);\\draw (2,0) to[L] (4,0);\\draw (2,0) to[R] (2,2);\\draw (4,0) to[C] (4,2);');
		expect(c.junctions.map((j) => [j.id, c.vertices[j.vertex]!.x])).toEqual([['J1', 400], ['J2', 200]]);
	});

	it('counts original degrees before a wire cycle loses an edge', () => {
		// (2,0) has the R end and two wires; the loop's last wire is dropped, but J1 stays.
		const c = accepted('\\draw (0,0) to[R] (2,0);\\draw (2,0) -- (4,0) -- (4,2) -- (2,2) -- cycle;');
		expect(c.junctions.map((j) => j.id)).toEqual(['J1']);
		expect(c.expected).toEqual([['R1.in'], ['R1.out']]);
		expect(edges(c)).toEqual(['R1.out -> J1.node #amber']);
	});

	it('checks the junction budget at the ceiling and before adding one more', () => {
		const span = { start: 0, end: 1, line: 1, column: 1, endColumn: 2 };
		for (const extra of [0, 1]) {
			const segments: Segment[] = [];
			for (let i = 0; i < LIMITS.junctions + extra; i += 1) {
				for (const [dx, dy] of [[-10, 0], [10, 0], [0, 10]]) segments.push({ from: { x: i * 200, y: 0 }, to: { x: i * 200 + dx!, y: dy! }, fromSpan: span, toSpan: span, span, spec: undefined });
			}
			const d = new Diagnostics(false), circuit = buildCircuit(segments, span, d);
			if (extra === 0) {
				expect(d.items.filter((item) => item.code === 'limit')).toEqual([]);
				expect(circuit?.junctions).toHaveLength(512);
			} else {
				expect(circuit).toBeUndefined();
				expect(d.items).toEqual([{ code: 'limit', severity: 'error', message: 'The junctions limit is 512; split the circuit across several documents.', line: 1, column: 1, endColumn: 2 }]);
			}
		}
	});
});

describe('wires that schemd cannot draw (R-5.1.5, R-5.1.6)', () => {
	it.each([
		['a stub off a terminal', '\\draw (0,0) to[R] (2,0) -- (3,0);', [DEAD_END]],
		['a stub off a junction', '\\draw (0,0) to[R] (2,0) to[C] (4,0);\\draw (2,0) -- (2,1);\\draw (2,0) to[L] (2,-2);', [DEAD_END]],
		['a stub with a corner', '\\draw (0,0) to[R] (2,0) -- (2,1) -- (3,1);', [DEAD_END]],
		['a lone wire', '\\draw (0,0) -- (2,0);', [EMPTY, ORPHAN]],
		['a lone wire beside a part', '\\draw (0,0) to[R] (2,0);\\draw (4,0) -- (6,0);', [ORPHAN]],
		['a lone wire loop beside a part', '\\draw (0,0) to[R] (2,0);\\draw (4,0) -- (6,0) -- (6,2) -- cycle;', [ORPHAN, ORPHAN]],
		['a lone wire star', '\\draw (0,0) -- (1,0) (0,0) -- (0,1) (0,0) -- (-1,0);', [DEAD_END, DEAD_END, DEAD_END]]
	])('rejects %s', (_, body, expected) => {
		expect(messages(body)).toEqual(expected);
	});

	it('reports the dead end at the wire that ends, not at the part', () => {
		expect(graphOf(wrap('\\draw (0,0) to[R] (2,0) -- (3,0);')).diagnostics[0]).toMatchObject({ line: 2, column: 25, endColumn: 27 });
	});

	it('keeps two wire loops through a part, whose dropped edge leaves no dead end', () => {
		const c = accepted('\\draw (0,0) to[R] (2,0) -- (2,2) -- (0,2) -- (0,0) -- (0,-2) -- (2,-2) -- (2,0);');
		expect(c.expected).toEqual([['R1.in', 'R1.out']]);
	});
});

describe('overlaps and endpoints inside a segment (R-5.1.7, R-5.1.8)', () => {
	/** [a, b] then [c, d] along one line; they overlap exactly when they share more than a point. */
	const intervals: [string, number, number, number, number][] = [
		['disjoint', 0, 2, 3, 5], ['touching', 0, 2, 2, 4], ['overlapping', 0, 3, 2, 5], ['contained', 0, 5, 1, 3],
		['equal', 0, 2, 0, 2], ['same start', 0, 2, 0, 4], ['same end', 0, 4, 2, 4], ['reversed', 2, 0, 3, 1]
	];
	const lines: [string, (t: number) => string][] = [
		['horizontal', (t) => `(${t},0)`], ['vertical', (t) => `(0,${t})`], ['diagonal', (t) => `(${t},${t})`], ['steep', (t) => `(${t},${2 * t})`]
	];
	it.each(intervals.flatMap(([relation, a, b, c, d]) => lines.map(([line, at]) => ({ relation, line, a, b, c, d, at }))))('$relation $line wires', ({ a, b, c, d, at }) => {
		const found = messages(`\\draw ${at(a)} -- ${at(b)};\\draw ${at(c)} -- ${at(d)};`);
		const overlapping = Math.max(Math.min(a, b), Math.min(c, d)) < Math.min(Math.max(a, b), Math.max(c, d));
		expect(found.includes(OVERLAP)).toBe(overlapping);
		// An endpoint strictly inside the other interval is ambiguous, but an overlap is reported once, alone.
		const inside = !overlapping && [c, d].some((t) => Math.min(a, b) < t && t < Math.max(a, b));
		expect(found.some((m) => m.startsWith('Endpoint ('))).toBe(inside);
	});

	it('remembers the furthest reach of a line, so a short segment cannot hide a long one', () => {
		// [0,5] contains [1,3]; [4,6] overlaps [0,5] although it starts after [1,3] ends.
		expect(messages('\\draw (0,0) -- (5,0);\\draw (1,0) -- (3,0);').filter((m) => m === OVERLAP)).toHaveLength(1);
		expect(messages('\\draw (0,0) -- (5,0);\\draw (1,0) -- (3,0);\\draw (4,0) -- (6,0);').filter((m) => m === OVERLAP)).toHaveLength(2);
	});

	it('reports an overlap between a part and a wire on its line', () => {
		expect(messages('\\draw (0,0) to[R] (2,0);\\draw (1,0) -- (3,0) to[C] (3,2);')).toContain(OVERLAP);
	});

	it('does not confuse parallel segments on different lines', () => {
		expect(accepted('\\draw (0,0) to[R] (2,0);\\draw (0,1) to[C] (2,1);').expected).toHaveLength(4);
		expect(accepted('\\draw (0,0) to[R] (0,2);\\draw (1,0) to[C] (1,2);').expected).toHaveLength(4);
	});

	it('reports a T whose stem ends inside a wire, with the point and the stem\'s span', () => {
		const result = graphOf(wrap('\\draw (0,0) to[R] (2,0) -- (4,0) to[R] (6,0);\n\\draw (3,0) to[C] (3,-2) -- (3,-3) to[R] (5,-3);'));
		expect(result.diagnostics).toEqual([{ code: 'geometry', severity: 'error', message: interior(300, 0), line: 3, column: 7, endColumn: 12 }]);
	});

	it.each([['at an endpoint', '(2,0)', 0], ['just inside', '(2.01,0)', 1], ['just inside the other end', '(3.99,0)', 1], ['at the other endpoint', '(4,0)', 0]])('a stem %s', (_, at, count) => {
		const found = messages(`\\draw (0,0) to[R] (2,0) -- (4,0) to[C] (6,0);\\draw ${at} to[L] ${at.replace(',0)', ',2)')};`);
		expect(found.filter((m) => m.startsWith('Endpoint (')), at).toHaveLength(count);
	});

	it('reports an endpoint at the crossing of two segments once', () => {
		const found = messages('\\draw (0,0) to[R] (0,2) -- (4,2) to[C] (4,0);\\draw (2,1) to[L] (2,3);\\draw (2,2) -- (3,3) to[R] (3,5);');
		expect(found.filter((m) => m === interior(200, 200))).toHaveLength(1);
	});

	it('finds a T on a diagonal wire too', () => {
		expect(messages('\\draw (0,0) to[R] (0,2) -- (4,6) to[C] (6,6);\\draw (2,4) to[L] (2,6);')).toContain(interior(200, 400));
	});

	it.each([
		['an overlap', '\\draw (0,0) to[R] (2,0) -- (5,0);\n\\draw (3,0) -- (6,0) to[C] (6,-2);', [OVERLAP]],
		['an overlap with a lone wire', '\\draw (0,0) to[R] (2,0) -- (4,0);\\draw (3,0) -- (5,0);', [OVERLAP]],
		['a wire stem ending inside a wire', '\\draw (0,0) to[R] (2,0) -- (4,0) to[C] (6,0);\\draw (3,0) -- (3,-2) to[L] (5,-2);', [interior(300, 0)]],
		['a lone wire ending inside another', '\\draw (0,0) to[R] (2,0) -- (4,0) to[C] (6,0);\\draw (3,0) -- (3,-2);', [interior(300, 0)]]
	])('reports %s alone, not the stubs and orphans it leaves', (_, body, expected) => {
		expect(messages(body)).toEqual(expected);
	});

	it('turns a split T into a real junction', () => {
		const c = accepted('\\draw (0,0) to[R] (2,0) -- (3,0) -- (4,0) to[R] (6,0);\n\\draw (3,0) to[C] (3,-2) -- (3,-3) to[R] (5,-3);');
		expect(c.junctions).toHaveLength(1);
		expect(c.expected).toContainEqual(['C1.in', 'R1.out', 'R2.in']);
	});
});

describe('component segments (R-4.4.4)', () => {
	const kinds = ['R', 'C', 'L', 'battery1'];
	it.each(kinds.flatMap((k) => [['(0,0)', '(0.84,0)'], ['(0.84,0)', '(0,0)'], ['(0,0)', '(0,0.84)'], ['(0,0.84)', '(0,0)']].map(([a, b]) => [k, a!, b!])))(
		'accepts %s at exactly 0.84 units from %s to %s', (kind, a, b) => {
			expect(accepted(`\\draw ${a} to[${kind}] ${b};`).parts).toHaveLength(1);
		});

	it.each(kinds.flatMap((k) => [['(0,0)', '(0.83,0)'], ['(0.83,0)', '(0,0)'], ['(0,0)', '(0,0.83)'], ['(0,0.83)', '(0,0)']].map(([a, b]) => [k, a!, b!])))(
		'rejects %s one hundredth short from %s to %s', (kind, a, b) => {
			const scale = (p: string) => p.replace('0.83', '83').replace(/\((\d+),(\d+)\)/, (_, x: string, y: string) => `(${x},${y})`);
			expect(messages(`\\draw ${a} to[${kind}] ${b};`)).toEqual([geometry(scale(a), scale(b), 'is too short')]);
		});

	it.each([['(0,0)', '(1,1)'], ['(1,1)', '(0,0)'], ['(0,1)', '(1,0)'], ['(0,0)', '(2,0.01)']])('rejects a diagonal part from %s to %s', (a, b) => {
		const hundredths = (p: string) => p.replace(/[\d.]+/g, (n) => String(Math.round(Number(n) * 100)));
		expect(messages(`\\draw ${a} to[R] ${b};`)).toEqual([geometry(hundredths(a), hundredths(b), 'is diagonal')]);
	});

	it('rejects a zero-length part, which a zero-length wire is not', () => {
		expect(messages('\\draw (1,1) to[C] (1,1);')[0]).toBe(geometry('(100,100)', '(100,100)', 'has zero length'));
	});

	it('numbers parts per prefix in source order', () => {
		const c = accepted('\\draw (0,0) to[R] (2,0) to[C] (4,0) to[R] (6,0) to[L] (8,0) to[battery1] (10,0) to[C] (12,0) to[battery1] (14,0);');
		expect(c.parts.map((p) => p.id)).toEqual(['R1', 'C1', 'R2', 'L1', 'B1', 'C2', 'B2']);
	});
});

describe('the canvas (core SCHEMATIC_LIMITS.maximumBound)', () => {
	const most = SCHEMATIC_LIMITS.maximumBound - 2 * MARGIN;
	const at = (n: number) => `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
	it.each([['wide', (n: number) => `\\draw (0,0) to[R] (${at(n)},0);`], ['tall', (n: number) => `\\draw (0,0) to[R] (0,${at(n)});`]])('fits a %s circuit at the limit and refuses one hundredth more', (_, body) => {
		expect(accepted(body(most)).bounds).toMatchObject({ minX: 0 });
		const { circuit, diagnostics } = graphOf(wrap(body(most + 1)));
		expect(circuit).toBeUndefined();
		// Reported in TikZ units, which is what the author writes.
		expect(diagnostics.map((d) => d.message)).toEqual([`The canvas extent limit is ${most / 100}; draw the circuit within that many TikZ units across and down.`]);
	});

	it('leaves a zero-length wire out of the drawing, so it moves no bound', () => {
		expect(accepted('\\draw (0,0) to[R] (2,0);\\draw (11000,0) -- (11000,0);').bounds).toEqual(accepted('\\draw (0,0) to[R] (2,0);').bounds);
		expect(accepted('\\draw (-50,50) -- (-50,50);\\draw (0,0) to[R] (2,0);').bounds).toEqual(accepted('\\draw (0,0) to[R] (2,0);').bounds);
	});

	it('measures from the drawing, not from the origin', () => {
		const c = accepted('\\draw (-50,-50) to[R] (-48,-50);');
		expect(c.bounds).toEqual({ minX: -5000, maxY: -5000, width: 200 + 2 * MARGIN, height: 2 * MARGIN });
	});
});

describe('segment directions (R-2.5.3)', () => {
	const star = (n: number) => `\\draw (0,0) to[R] (0,-2);\n\\draw${Array.from({ length: n }, (_, k) => ` (0,0) -- (${k + 1},1)`).join('')};`;
	it('accepts as many directions as the ceiling, counting the part\'s own', () => {
		// The part is vertical; the star adds LIMITS.directions - 1 slopes (k, 1), all distinct.
		expect(messages(star(LIMITS.directions - 1)).filter((m) => m.startsWith('The wire directions'))).toEqual([]);
	});

	it('refuses one direction more, at the segment that brings it, and reports nothing after', () => {
		const source = wrap(star(LIMITS.directions)), { diagnostics } = graphOf(source);
		expect(diagnostics.map(({ code, message, line }) => ({ code, message, line }))).toEqual([{ code: 'limit', line: 3,
			message: 'The wire directions limit is 64; draw the wires horizontally or vertically.' }]);
		// The span is the 64th wire of the star, the first with a 65th direction.
		const text = source.split('\n')[2]!;
		expect(text.slice(diagnostics[0]!.column - 1)).toMatch(/^-- \(64,1\)/);
	});

	it('counts a direction and its reverse once, and parallel lines once', () => {
		expect(messages('\\draw (0,0) to[R] (2,0) -- (2,2) to[C] (0,2) -- (0,0);\\draw (4,0) to[L] (6,0) -- (6,2) to[R] (4,2) -- (4,0);').filter((m) => m.includes('directions'))).toEqual([]);
	});
});

describe('connections (R-5.2)', () => {
	it('runs a wire connection the way the pen went', () => {
		const forward = accepted('\\draw (0,0) to[R] (2,0);\\draw (4,0) to[C] (6,0);\\draw (2,0) -- (3,0) -- (4,0);');
		const backward = accepted('\\draw (0,0) to[R] (2,0);\\draw (4,0) to[C] (6,0);\\draw (4,0) -- (3,0) -- (2,0);');
		expect(edges(forward)).toEqual(['R1.out -> C1.in #amber']);
		expect(edges(backward)).toEqual(['C1.in -> R1.out #cyan']);
		expect(backward.expected).toEqual(forward.expected);
	});

	it('uses the earliest wire of a chain drawn in pieces', () => {
		const c = accepted('\\draw (0,0) to[R] (2,0);\\draw (6,0) to[C] (8,0);\\draw (4,0) -- (2,0);\\draw (4,0) -- (6,0);');
		// The first wire drawn runs from (4,0) toward R1.out, so the connection does too.
		expect(edges(c)).toEqual(['C1.in -> R1.out #cyan']);
	});

	it('follows the earliest wire even when the walk meets a later one first', () => {
		// From R1.out the walk meets (2,0) -- (4,0) first, but (6,0) -- (4,0) was drawn earlier, toward R1.
		const c = accepted('\\draw (0,0) to[R] (2,0);\\draw (6,0) to[C] (8,0);\\draw (6,0) -- (4,0);\\draw (2,0) -- (4,0);');
		expect(edges(c)).toEqual(['C1.in -> R1.out #cyan']);
	});

	it('connects parts that touch directly in source order', () => {
		expect(edges(accepted('\\draw (0,0) to[R] (2,0) to[C] (4,0);'))).toEqual(['R1.out -> C1.in #amber']);
		// C1.in is the first of the two terminals the TeX reaches at (2,0).
		expect(edges(accepted('\\draw (2,0) to[C] (4,0);\\draw (0,0) to[R] (2,0);'))).toEqual(['C1.in -> R1.out #cyan']);
	});

	it('runs a direct junction contact out of the junction toward a start, into it from an end', () => {
		const c = accepted('\\draw (0,0) to[R] (2,0);\\draw (2,0) to[C] (4,0);\\draw (2,0) to[L] (2,2);');
		expect(edges(c)).toEqual(['R1.out -> J1.node #amber', 'J1.node -> C1.in #slate', 'J1.node -> L1.in #slate']);
	});

	it('colours a connection by the kind it leaves', () => {
		const c = accepted('\\draw (0,0) to[battery1] (2,0) to[R] (4,0) to[C] (6,0) to[L] (8,0);');
		expect(c.connections.map((k) => k.color)).toEqual(['blue', 'amber', 'cyan']);
	});

	it('names terminals by the part\'s ports, swapped by invert', () => {
		expect(edges(accepted('\\draw (0,0) to[R] (2,0) to[R,invert] (4,0);'))).toEqual(['R1.out -> R2.out #amber']);
		expect(edges(accepted('\\draw (0,0) to[battery1] (2,0) to[R] (4,0);'))).toEqual(['B1.negative -> R1.in #blue']);
		expect(edges(accepted('\\draw (0,0) to[battery1] (2,0) to[R] (4,0);', '[fixbatteries]'))).toEqual(['B1.positive -> R1.in #blue']);
	});
});

describe('metamorphic properties', () => {
	const shape = (dx: number, dy: number) => `\\draw (${dx},${dy}) to[R=100] (${dx + 2},${dy}) -- (${dx + 2},${dy + 2}) to[C] (${dx},${dy + 2}) -- (${dx},${dy});\\draw (${dx + 2},${dy}) -- (${dx + 4},${dy}) to[L] (${dx + 4},${dy + 2}) -- (${dx + 2},${dy + 2});`;
	const view = (c: Circuit) => ({ expected: c.expected, connections: edges(c), junctions: c.junctions.map((j) => j.id), bounds: [c.bounds.width, c.bounds.height] });

	it.each([[-10, 7], [3, -4], [0.5, 0.25], [-0.01, 0.01], [400, -400]])('translating by (%s, %s) changes nothing but the origin', (dx, dy) => {
		expect(view(accepted(shape(dx, dy)))).toEqual(view(accepted(shape(0, 0))));
	});

	it('reordering independent statements keeps every net', () => {
		const statements = ['\\draw (0,0) to[R] (2,0);', '\\draw (4,0) to[C] (6,0);', '\\draw (2,0) -- (4,0);', '\\draw (6,0) -- (6,2) to[L] (0,2) -- (0,0);'];
		const reference = accepted(statements.join('')).expected;
		for (let i = 0; i < 24; i += 1) {
			const order = [...statements], picked: string[] = [];
			for (let n = i, k = order.length; k > 0; n = Math.floor(n / k), k -= 1) picked.push(order.splice(n % k, 1)[0]!);
			const c = accepted(picked.join(''));
			// IDs follow source order, so compare nets by kind and shape rather than by name.
			expect(c.expected.length).toBe(reference.length);
			expect(c.connections.length).toBe(3);
		}
	});

	it('builds the same circuit twice from the same segments', () => {
		const source = wrap(shape(0, 0));
		expect(graphOf(source)).toEqual(graphOf(source));
	});
});

describe('a brute-force model of the graph on random circuits', () => {
	/** mulberry32: a small seeded generator, so a failure names its case. */
	const random = (seed: number) => () => {
		seed = seed + 0x6d2b79f5 | 0;
		let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
	type Step = { from: [number, number]; to: [number, number]; kind: string };
	const PORTS: Record<string, [string, string, string]> = { R: ['R', 'in', 'out'], C: ['C', 'in', 'out'], L: ['L', 'in', 'out'], battery1: ['B', 'positive', 'negative'] };

	function circuitFor(seed: number): { body: string; steps: Step[] } {
		const next = random(seed), pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
		const steps: Step[] = [], statements: string[] = [];
		for (let s = 0, n = 1 + Math.floor(next() * 4); s < n; s += 1) {
			let at: [number, number] = [pick([0, 2, 4]), pick([0, 2, 4])];
			let text = `\\draw (${at[0]},${at[1]})`;
			for (let e = 0, m = 1 + Math.floor(next() * 4); e < m; e += 1) {
				const kind = pick(['--', '--', 'R', 'C', 'L', 'battery1', 'short']);
				const axis = next() < 0.5 ? 0 : 1, length = pick([-4, -2, 2, 4, ...(kind === '--' ? [0] : [])]);
				const to: [number, number] = axis === 0 ? [at[0] + length, at[1]] : [at[0], at[1] + length];
				text += `${kind === '--' ? ' --' : ` to[${kind}${next() < 0.2 && kind !== 'short' ? ',invert' : ''}]`} (${to[0]},${to[1]})`;
				steps.push({ from: at, to, kind: text.endsWith(`invert] (${to[0]},${to[1]})`) ? `${kind}!` : kind });
				at = to;
			}
			statements.push(`${text};`);
		}
		return { body: statements.join('\n'), steps };
	}

	/** Everything the requirements say about the graph, computed the obvious, quadratic way. */
	function model(steps: readonly Step[]) {
		const key = (p: readonly [number, number]) => `${p[0] * 100},${p[1] * 100}`;
		const wire = (s: Step) => s.kind === '--' || s.kind === 'short';
		const real = steps.filter((s) => !(wire(s) && key(s.from) === key(s.to)));
		const degree = new Map<string, number>(), order: string[] = [];
		// A zero-length wire makes no point of the drawing, so its point is no vertex.
		for (const s of real) for (const p of [s.from, s.to]) if (!order.includes(key(p))) order.push(key(p));
		for (const s of real) for (const p of [s.from, s.to]) degree.set(key(p), (degree.get(key(p)) ?? 0) + 1);
		// Nets: flood fill over wire segments.
		const net = new Map<string, number>();
		for (const start of order) {
			if (net.has(start)) continue;
			const stack = [start];
			net.set(start, net.size);
			const id = net.get(start)!;
			while (stack.length > 0) {
				const at = stack.pop()!;
				for (const s of real.filter(wire)) for (const [a, b] of [[key(s.from), key(s.to)], [key(s.to), key(s.from)]]) {
					if (a === at && !net.has(b!)) { net.set(b!, id); stack.push(b!); }
				}
			}
		}
		const counts = new Map<string, number>(), terminals = new Map<number, string[]>();
		for (const s of real.filter((s) => !wire(s))) {
			const [prefix, first, last] = PORTS[s.kind.replace('!', '')]!;
			const n = (counts.get(prefix) ?? 0) + 1; counts.set(prefix, n);
			const [a, b] = s.kind.endsWith('!') ? [last, first] : [first, last];
			for (const [p, port] of [[s.from, a], [s.to, b]] as const) {
				const id = net.get(key(p))!;
				terminals.set(id, [...(terminals.get(id) ?? []), `${prefix}${n}.${port}`]);
			}
		}
		const junctions = order.filter((v) => (degree.get(v) ?? 0) >= 3);
		// Overlaps and interior endpoints, axis by axis: every step here is horizontal or vertical.
		const span = (s: Step) => s.from[0] === s.to[0]
			? { line: `x${s.from[0]}`, low: Math.min(s.from[1], s.to[1]), high: Math.max(s.from[1], s.to[1]) }
			: { line: `y${s.from[1]}`, low: Math.min(s.from[0], s.to[0]), high: Math.max(s.from[0], s.to[0]) };
		const solid = real.filter((s) => key(s.from) !== key(s.to)).map(span);
		const overlap = solid.some((a, i) => solid.some((b, j) => i < j && a.line === b.line && Math.max(a.low, b.low) < Math.min(a.high, b.high)));
		const inside = !overlap && order.some((v) => {
			const [x, y] = v.split(',').map((n) => Number(n) / 100);
			return solid.some((s) => s.line === `x${x}` && s.low < y! && y! < s.high || s.line === `y${y}` && s.low < x! && x! < s.high);
		});
		const anchored = new Set([...terminals.keys(), ...junctions.map((v) => net.get(v)!)]);
		// Ambiguous geometry already explains the ends it leaves apart, so they are not reported again.
		const orphan = !overlap && !inside && real.some((s) => wire(s) && !anchored.has(net.get(key(s.from))!));
		const deadEnd = !overlap && !inside && real.some((s) => wire(s) && [s.from, s.to].some((p) => degree.get(key(p)) === 1 && anchored.has(net.get(key(p))!)));
		return { expected: canonical([...terminals.values()]), junctions, overlap, inside, orphan, deadEnd, empty: terminals.size === 0 && junctions.length === 0 };
	}

	it('agrees with the model on 3000 seeded circuits, and accepts enough of them to mean something', () => {
		let clean = 0;
		for (let seed = 1; seed <= 3000; seed += 1) {
			const { body, steps } = circuitFor(seed);
			const { circuit, diagnostics } = graphOf(wrap(body));
			const found = diagnostics.map((d) => d.message);
			const m = model(steps);
			const label = `seed ${seed}:\n${body}`;
			expect(circuit, label).toBeDefined();
			expect(circuit!.expected, label).toEqual(m.expected);
			expect(circuit!.junctions.map((j) => { const v = circuit!.vertices[j.vertex]!; return `${v.x},${v.y}`; }), label).toEqual(m.junctions);
			expect(found.includes(OVERLAP), label).toBe(m.overlap);
			expect(found.some((x) => x.startsWith('Endpoint (')), label).toBe(m.inside);
			expect(found.includes(ORPHAN), label).toBe(m.orphan);
			expect(found.includes(DEAD_END), label).toBe(m.deadEnd);
			expect(found.includes(EMPTY), label).toBe(m.empty);
			if (diagnostics.length > 0) continue;
			clean += 1;
			// The connections are a spanning forest over the anchors of each net: k anchors, k - 1 connections, all joined.
			const anchors = new Map<string, string[]>();
			const netOf = new Map(circuit!.expected.flatMap((net, i) => net.map((t) => [t, i] as const)));
			for (const k of circuit!.connections) {
				expect(k.from, label).not.toBe(k.to);
				const part = circuit!.parts.find((p) => k.from.startsWith(`${p.id}.`));
				expect(k.color, label).toBe(part?.spec.color ?? 'slate');
			}
			const parent = new Map<string, string>();
			const find = (x: string): string => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!; return x; };
			for (const k of circuit!.connections) {
				const a = find(k.from), b = find(k.to);
				expect(a, `${label}\na cycle through ${k.from} -> ${k.to}`).not.toBe(b);
				parent.set(a, b);
			}
			for (const [terminal, i] of netOf) anchors.set(String(i), [...(anchors.get(String(i)) ?? []), terminal]);
			for (const terminals of anchors.values()) expect(new Set(terminals.map(find)).size, label).toBe(1);
		}
		expect(clean).toBeGreaterThan(300);
	});
});
