import { describe, expect, it } from 'vitest';

import { convertCircuitikz } from '../src/index.js';
import { Diagnostics } from '../src/diagnostics.js';
import { decimal, coordinate, isName, resolveCoordinates } from '../src/coordinates.js';
import { scan, textOf, through } from '../src/lexer.js';
import { optionsOf } from '../src/options.js';
import { parse } from '../src/parser.js';
import { LIMITS } from '../src/limits.js';
import type { ConvertCircuitikzOptions } from '../src/types.js';

const wrap = (text: string) => `\\begin{circuitikz}\n${text}\n\\end{circuitikz}`;
function read(text: string) {
	const diagnostics = new Diagnostics(false);
	const tokens = scan(text, diagnostics);
	const tree = parse(tokens, diagnostics);
	const segments = tree === undefined ? [] : resolveCoordinates(tree, diagnostics);
	return { diagnostics: diagnostics.sorted(), tree, segments, tokens };
}
const span = { start: 0, end: 1, line: 1, column: 1, endColumn: 2 };

describe('span helpers', () => {
	it('joins same-line spans and clamps multiline spans to the first token', () => {
		const tokens = scan('a b\nccc', new Diagnostics(false));
		expect(through(tokens[0]!, tokens[1]!)).toEqual({ start: 0, end: 3, line: 1, column: 1, endColumn: 4 });
		expect(through(tokens[0]!, tokens[2]!)).toEqual({ start: 0, end: 7, line: 1, column: 1, endColumn: 2 });
	});
});

describe('exact decimals and names', () => {
	it.each([['0', 0], ['-0', 0], ['+0.00', 0], ['1', 100], ['-1.2cm', -120], ['+12.34', 1234], ['1.', 100], ['90071992547409.91', Number.MAX_SAFE_INTEGER]])('parses %s exactly', (text, value) => {
		const d = new Diagnostics(false);
		expect(decimal(text, span, d)).toBe(value);
		expect(d.items).toEqual([]);
	});

	it.each(['.5', 'cm', '1mm', '1e2', '1.2.3', '1 cm'])('rejects unsupported numeric form %s', (text) => {
		const d = new Diagnostics(false);
		expect(decimal(text, span, d)).toBeUndefined();
		expect(d.items).toEqual([{ code: 'unsupported', severity: 'error', message: `Coordinate value ${text} is not supported; use the documented CircuiTikZ subset instead.`, line: 1, column: 1, endColumn: 2 }]);
	});

	it.each(['1.000', '0.001cm'])('never rounds %s', (text) => {
		const d = new Diagnostics(false);
		expect(decimal(text, span, d)).toBeUndefined();
		expect(d.items).toEqual([{ code: 'syntax', severity: 'error', message: `${text} has more than two decimal places; use at most two decimal places without rounding.`, line: 1, column: 1, endColumn: 2 }]);
	});

	it.each(['9007199254740992', '90071992547410', '90071992547409.92'])('detects overflow in %s before rounding', (text) => {
		const d = new Diagnostics(false);
		expect(decimal(text, span, d)).toBeUndefined();
		expect(d.items).toEqual([{ code: 'limit', severity: 'error', message: 'The coordinate exceeds the exact integer range; use smaller coordinates or relative offsets.', line: 1, column: 1, endColumn: 2 }]);
	});

	it.each([['A', true], ['_a01', true], ['z', true], ['', false], ['1a', true], ['A.north', false], ['α', true], ['a\u0000', false]])('checks literal coordinate name %s', (text, expected) => {
		expect(isName(text)).toBe(expected);
	});

	it('rejects empty, polar, calculated and compound scalar coordinates', () => {
		for (const text of ['', '30:2', '$A$', 'A \\|- B']) {
			const d = new Diagnostics(false);
			const tokens = scan(text, d).slice(0, -1);
			expect(coordinate(tokens, 'absolute', span, d)).toBeUndefined();
			expect(d.items).toEqual([{ code: 'unsupported', severity: 'error', message: 'This coordinate form is not supported; use the documented CircuiTikZ subset instead.', line: 1, column: 1, endColumn: 2 }]);
		}
		for (const text of [',0', '1 2,0', '0,1,2']) {
			const d = new Diagnostics(false);
			expect(coordinate(scan(text, d).slice(0, -1), '+', span, d)).toBeUndefined();
			expect(d.items).toEqual([{ code: 'syntax', severity: 'error', message: 'Expected a decimal coordinate with optional cm units; correct the statement before converting it.', line: 1, column: 1, endColumn: 2 }]);
		}
	});
});

describe('span-aware parser and resolver', () => {
	it('resolves literal numeric, hyphenated, spaced and Unicode TikZ names', () => {
		for (const name of ['1', 'top-A', 'start of chart', 'α😀']) {
			const result = read(wrap(`\\coordinate (${name}) at (1,2);\n\\draw (${name}) -- ++(1,0);`));
			expect(result.diagnostics).toEqual([]);
			expect(result.segments.map(({ from, to }) => [from, to])).toEqual([[{ x: 100, y: 200 }, { x: 200, y: 200 }]]);
		}
	});
	it('keeps AST operations, names, options and exact coordinates', () => {
		const result = read(wrap('\\coordinate (A) at (1cm,-2.50cm);\n\\draw[thick] (A) coordinate (B) to[R=$R_{1}$,l={a,b}] ++(2,0) |- +(0,1) -| (A);'));
		expect(result.diagnostics).toEqual([]);
		expect(result.tree?.statements.map((s) => s.kind)).toEqual(['coordinate', 'draw']);
		expect(result.tree?.statements[1]).toMatchObject({ keys: [{ name: 'thick', value: undefined }], elements: [
			{ kind: 'move', at: { kind: 'reference', name: 'A' } }, { kind: 'name', name: 'B' },
			{ kind: 'segment', operation: 'to', keys: [{ name: 'R' }, { name: 'l' }], at: { x: 200, y: 0, mode: '++' } },
			{ kind: 'segment', operation: '|-' }, { kind: 'segment', operation: '-|' }
		] });
		expect(result.segments.map(({ from, to }) => [from, to])).toEqual([
			[{ x: 100, y: -250 }, { x: 300, y: -250 }],
			[{ x: 300, y: -250 }, { x: 300, y: -150 }],
			[{ x: 300, y: -150 }, { x: 100, y: -250 }]
		]);
	});

	it('rejects cycle after to[...], which CircuiTikZ closes inside the component drawing', () => {
		const message = 'cycle after to[...] closes inside that component\'s drawing in CircuiTikZ; end the path at an explicit coordinate instead.';
		for (const operation of ['to[R]', 'to[short]']) {
			const result = read(wrap(`\\draw (0,0) ${operation} (2,0) -- (2,2) -- cycle;`));
			expect(result.tree?.statements[0]).toMatchObject({ elements: [{}, {}, {}, { kind: 'segment', operation: '--', at: { kind: 'cycle' } }] });
			expect(result.diagnostics).toEqual([{ code: 'unsupported', severity: 'error', message, line: 2, column: 32 + operation.length, endColumn: 37 + operation.length }]);
			expect(result.segments).toHaveLength(2);
		}
		// A move-to starts a fresh subpath of wires, which cycle closes exactly.
		const fresh = read(wrap('\\draw (0,0) to[R] (2,0) (2,1) -- (2,2) -- (0,2) -- cycle;'));
		expect(fresh.diagnostics).toEqual([]);
		expect(fresh.segments.at(-1)).toMatchObject({ from: { x: 0, y: 200 }, to: { x: 200, y: 100 } });
	});

	it('distinguishes + from ++ and moves the pen to both', () => {
		const plus = read(wrap('\\draw (0,0) -- +(1,0) -- +(0,1);'));
		const increment = read(wrap('\\draw (0,0) -- ++(1,0) -- ++(0,1);'));
		expect(plus.segments.map(({ to }) => to)).toEqual([{ x: 100, y: 0 }, { x: 0, y: 100 }]);
		expect(increment.segments.map(({ to }) => to)).toEqual([{ x: 100, y: 0 }, { x: 100, y: 100 }]);
		expect(plus.segments[1]?.from).toEqual({ x: 100, y: 0 });
	});

	it('resolves inline names, moves and cycles without edges for moves', () => {
		expect(read(wrap('\\draw (0,0) -- (2,0) -- cycle;')).segments.at(-1)?.to).toEqual({ x: 0, y: 0 });
		const result = read(wrap('\\draw (1,1) coordinate (A) -- ++(1,0) (0,0) -- (A) -- cycle;'));
		expect(result.diagnostics).toEqual([]);
		// `cycle` closes the current subpath, which the move to (0,0) started.
		expect(result.segments.map(({ from, to }) => [from, to])).toEqual([
			[{ x: 100, y: 100 }, { x: 200, y: 100 }],
			[{ x: 0, y: 0 }, { x: 100, y: 100 }],
			[{ x: 100, y: 100 }, { x: 0, y: 0 }]
		]);
	});

	it('detects relative arithmetic overflow on either axis', () => {
		for (const [point, offset] of [['90071992547409.91,0', '0.01,0'], ['0,-90071992547409.91', '0,-0.01']]) {
			const result = read(wrap(`\\draw (${point}) -- ++(${offset});`));
			expect(result.segments).toEqual([]);
			expect(result.diagnostics).toMatchObject([{ code: 'limit', message: 'The coordinate exceeds the exact integer range; use smaller coordinates or relative offsets.' }]);
		}
	});

	it('reports independent missing names within one path and resumes at an absolute point', () => {
		const result = read(wrap('\\draw (missing) coordinate (A) -- +(1,0) -- (other) -- (0,0) -- ++(2,0);'));
		expect(result.diagnostics).toEqual([
			{ code: 'reference', severity: 'error', message: 'Coordinate missing is not defined; define it before using it.', line: 2, column: 7, endColumn: 16 },
			{ code: 'reference', severity: 'error', message: 'Coordinate other is not defined; define it before using it.', line: 2, column: 45, endColumn: 52 }
		]);
		expect(result.segments.map(({ from, to }) => [from, to])).toEqual([[{ x: 0, y: 0 }, { x: 200, y: 0 }]]);
	});

	it('reports undefined and duplicate names at their definitions and uses', () => {
		const result = read(wrap('\\coordinate (A) at (0,0);\n\\coordinate (A) at (1,1);\n\\coordinate (B) at (missing);\n\\draw (other) -- (0,0);\n\\draw (0,0) coordinate (A);'));
		expect(result.diagnostics).toEqual([
			{ code: 'reference', severity: 'error', message: 'Coordinate A is already defined; give the second definition a different name.', line: 3, column: 14, endColumn: 15 },
			{ code: 'reference', severity: 'error', message: 'Coordinate missing is not defined; define it before using it.', line: 4, column: 20, endColumn: 29 },
			{ code: 'reference', severity: 'error', message: 'Coordinate other is not defined; define it before using it.', line: 5, column: 7, endColumn: 14 },
			{ code: 'reference', severity: 'error', message: 'Coordinate A is already defined; give the second definition a different name.', line: 6, column: 25, endColumn: 26 }
		]);
	});

	it('keeps a move in the middle of a path as a move, and cycle as a destination', () => {
		const result = read(wrap('\\draw (0,0) -- (1,0) (2,0) -- +(0,1) -- cycle;'));
		expect(result.diagnostics).toEqual([]);
		expect(result.tree?.statements[0]).toMatchObject({ elements: [
			{ kind: 'move', at: { x: 0, y: 0 } }, { kind: 'segment', operation: '--' },
			{ kind: 'move', at: { x: 200, y: 0, mode: 'absolute' } }, { kind: 'segment', at: { x: 0, y: 100, mode: '+' } },
			{ kind: 'segment', operation: '--', at: { kind: 'cycle' } }
		] });
	});

	it('reports an unresolved point once, not again at each name built on it', () => {
		const missing = { code: 'reference', severity: 'error', message: 'Coordinate missing is not defined; define it before using it.', line: 2, column: 20, endColumn: 29 };
		expect(read(wrap('\\coordinate (A) at (missing);\n\\draw (A) -- +(1,0) coordinate (B);\n\\draw (B) -- (2,0);')).diagnostics).toEqual([missing]);
		// A name defined from an unresolved point is still defined, so a second definition is reported.
		expect(read(wrap('\\coordinate (A) at (missing);\n\\coordinate (A) at (0,0);')).diagnostics).toEqual([
			missing,
			{ code: 'reference', severity: 'error', message: 'Coordinate A is already defined; give the second definition a different name.', line: 3, column: 14, endColumn: 15 }
		]);
		const overflow = read(wrap('\\draw (90071992547409.91,0) -- ++(0.01,0) coordinate (O);\n\\draw (O) -- (0,0);'));
		expect(overflow.diagnostics).toEqual([{ code: 'limit', severity: 'error', message: 'The coordinate exceeds the exact integer range; use smaller coordinates or relative offsets.', line: 2, column: 32, endColumn: 42 }]);
	});

	// Each expectation was read back from TikZ (tectonic, \pgfgetlastxy after each point).
	it.each([
		{ name: 'a relative \\coordinate starts from the origin', tex: '\\coordinate (P) at +(1,0);\n\\draw (P) -- (0,0);', from: { x: 100, y: 0 } },
		{ name: 'a statement does not inherit the previous one', tex: '\\draw (3,3) -- (4,4);\n\\coordinate (P) at ++(1,2);\n\\draw (P) -- (0,0);', from: { x: 100, y: 200 } },
		{ name: 'a path may start with a relative point', tex: '\\draw +(2,0) -- (5,5);', from: { x: 200, y: 0 } },
		{ name: '++ after cycle starts from the subpath start', tex: '\\draw (0,0) -- (1,0) -- (1,1) -- cycle -- ++(0,2);', to: { x: 0, y: 200 } },
		{ name: '+ after cycle keeps the subpath start as reference', tex: '\\draw (0,0) -- (1,0) -- (1,1) -- cycle -- +(0,2) -- +(1,0);', to: { x: 100, y: 0 } },
		{ name: 'coordinate (name) does not move the reference', tex: '\\draw (2,2) coordinate (N) -- +(1,0) -- +(0,1);', to: { x: 200, y: 300 } },
		{ name: 'a move resets the reference', tex: '\\draw (0,0) -- ++(1,0) (5,5) -- +(1,1);', to: { x: 600, y: 600 } },
		{ name: 'runs of spaces and a line break in a name are one space', tex: '\\coordinate (start of chart) at (7,7);\n\\draw (start   of chart) -- (start\nof chart);', from: { x: 700, y: 700 }, to: { x: 700, y: 700 } }
	])('resolves as TikZ does: $name', ({ tex, from, to }) => {
		const result = read(wrap(tex));
		expect(result.diagnostics).toEqual([]);
		if (from !== undefined) expect(result.segments.at(-1)?.from).toEqual(from);
		if (to !== undefined) expect(result.segments.at(-1)?.to).toEqual(to);
	});

	const notDefined = (name: string, line: number, column: number) => ({ code: 'reference', severity: 'error', message: `Coordinate ${name} is not defined; define it before using it.`, line, column, endColumn: column + name.length + 2 });
	it.each([
		{ name: 'a use before a later definition in the same path', tex: '\\draw (A) -- (0,0) coordinate (A) -- (1,0);', diagnostics: [notDefined('A', 2, 7)], segments: [[{ x: 0, y: 0 }, { x: 100, y: 0 }]] },
		{ name: 'a use before a later \\coordinate', tex: '\\draw (B) -- (0,0);\n\\coordinate (B) at (1,1);\n\\draw (B) -- (0,0);', diagnostics: [notDefined('B', 2, 7)], segments: [[{ x: 100, y: 100 }, { x: 0, y: 0 }]] },
		{ name: 'relative points after an unresolved start, until an absolute one', tex: '\\draw (missing) -- +(1,0) -- ++(1,0) -- (2,2) -- +(1,0);', diagnostics: [notDefined('missing', 2, 7)], segments: [[{ x: 200, y: 200 }, { x: 300, y: 200 }]] },
		{ name: 'cycle back to an unresolved subpath start', tex: '\\draw (missing) -- (1,0) -- (1,1) -- cycle;', diagnostics: [notDefined('missing', 2, 7)], segments: [[{ x: 100, y: 0 }, { x: 100, y: 100 }]] },
		{ name: 'cycle straight after the move-to', tex: '\\draw (1,1) -- cycle;', diagnostics: [], segments: [[{ x: 100, y: 100 }, { x: 100, y: 100 }]] },
		{ name: 'a corner operation to a relative point', tex: '\\draw (1,0) |- ++(1,1) -| +(-1,1);', diagnostics: [], segments: [[{ x: 100, y: 0 }, { x: 200, y: 100 }], [{ x: 200, y: 100 }, { x: 100, y: 200 }]] },
		{ name: 'a Unicode name, defined inline and reused', tex: '\\draw (1,2) coordinate (α😀) -- (0,0);\n\\draw (α😀) -- ++(1,0);', diagnostics: [], segments: [[{ x: 100, y: 200 }, { x: 0, y: 0 }], [{ x: 100, y: 200 }, { x: 200, y: 200 }]] }
	])('resolution edge case: $name', ({ tex, diagnostics, segments }) => {
		const result = read(wrap(tex));
		expect(result.diagnostics).toEqual(diagnostics);
		expect(result.segments.map(({ from, to }) => [from, to])).toEqual(segments);
	});

	// Read back from TikZ (tectonic) with both (AB) at (1,2) and (A B) at (3,4) defined.
	it.each([
		{ name: 'a comment joins the two lines', tex: '(A% comment\nB)', at: { x: 100, y: 200 } },
		{ name: 'leading blanks after a comment are dropped', tex: '(A% comment\n   \tB)', at: { x: 100, y: 200 } },
		{ name: 'two comment lines still join', tex: '(A%\n%\nB)', at: { x: 100, y: 200 } },
		{ name: 'a space before the comment is kept', tex: '(A % comment\nB)', at: { x: 300, y: 400 } },
		{ name: 'a plain line break is a space', tex: '(A\nB)', at: { x: 300, y: 400 } }
	])('reads a name across lines as TeX does: $name', ({ tex, at }) => {
		const result = read(wrap(`\\coordinate (AB) at (1,2);\n\\coordinate (A B) at (3,4);\n\\draw ${tex} -- (0,0);`));
		expect(result.diagnostics).toEqual([]);
		expect(result.segments.at(-1)?.from).toEqual(at);
	});

	it('joins a commented line break in inline names and option keys too', () => {
		const result = read(wrap('\\draw (1,1) coordinate (A%\nB) -- (0,0);\n\\draw (AB) -- (2,2);\n\\draw (0,0) to[american%\n resistor] (1,0);'));
		expect(result.diagnostics).toEqual([]);
		expect(result.segments[1]?.from).toEqual({ x: 100, y: 100 });
		expect(result.tree?.statements[2]).toMatchObject({ elements: [{}, { keys: [{ name: 'americanresistor' }] }] });
	});

	it.each([
		{ name: 'a duplicate name', tex: '\\coordinate (A) at (0,0);\n\\coordinate (A) at (1,1);', messages: ['Coordinate A is already defined; give the second definition a different name.'] },
		{ name: 'cycle after to[...]', tex: '\\draw (0,0) to[R] (1,0) -- cycle;', messages: ['cycle after to[...] closes inside that component\'s drawing in CircuiTikZ; end the path at an explicit coordinate instead.'] },
		{ name: 'a relative overflow', tex: '\\draw (90071992547409.91,0) -- ++(0.01,0);', messages: ['The coordinate exceeds the exact integer range; use smaller coordinates or relative offsets.'] },
		// An unfinished last statement is dropped, so its names are not resolved and add nothing.
		{ name: 'an unfinished last statement', tex: '\\draw (missing) -- (0,0', messages: ['Expected ); correct the statement before converting it.'] }
	])('keeps coordinate diagnostics when the environment end is missing: $name', ({ tex, messages }) => {
		const result = read(`\\begin{circuitikz}\n${tex}\n`);
		expect(result.diagnostics.map((d) => d.message)).toEqual([...messages, 'Expected \\end{circuitikz}; correct the statement before converting it.']);
	});

	it('keeps names case-sensitive', () => {
		expect(read(wrap('\\coordinate (a) at (1,1);\n\\draw (A) -- (0,0);')).diagnostics).toEqual([
			{ code: 'reference', severity: 'error', message: 'Coordinate A is not defined; define it before using it.', line: 3, column: 7, endColumn: 10 }
		]);
	});

	it('does not let errors in one statement hide the next statement', () => {
		const result = read(wrap('\\draw (0,0) to[R] (1,;\n\\node {a;b};\n\\draw (0,0) arc (1,1);\n\\coordinate (A) at (missing);'));
		expect(result.diagnostics).toEqual([
			{ code: 'syntax', severity: 'error', message: 'Expected ); correct the statement before converting it.', line: 2, column: 22, endColumn: 23 },
			{ code: 'unsupported', severity: 'error', message: '\\node is not supported; use the documented CircuiTikZ subset instead.', line: 3, column: 1, endColumn: 6 },
			{ code: 'unsupported', severity: 'error', message: 'arc is not supported; use the documented CircuiTikZ subset instead.', line: 4, column: 13, endColumn: 16 },
			{ code: 'reference', severity: 'error', message: 'Coordinate missing is not defined; define it before using it.', line: 5, column: 20, endColumn: 29 }
		]);
	});

	it.each(['', '\\begin{tikzpicture}\\end{tikzpicture}', 'text ' + wrap('')])('requires exactly one environment: %s', (text) => {
		expect(read(text).diagnostics).toEqual([{ code: 'unsupported', severity: 'error', message: 'Pass a single \\begin{circuitikz} … \\end{circuitikz} environment, with only whitespace or comments outside it.', line: 1, column: 1, endColumn: text === '' ? 1 : text.startsWith('text') ? 5 : 7 }]);
	});

	it('accepts surrounding comments and reports trailing environments', () => {
		expect(read('% before\r' + wrap('') + '% after').diagnostics).toEqual([]);
		expect(read(wrap('') + '\n' + wrap('')).diagnostics).toEqual([{ code: 'unsupported', severity: 'error', message: 'Pass a single \\begin{circuitikz} … \\end{circuitikz} environment, with only whitespace or comments outside it.', line: 4, column: 1, endColumn: 7 }]);
	});

	it('reports unterminated input and missing semicolons at the last token end', () => {
		expect(read('\\begin{circuitikz}\\coordinate (').diagnostics).toEqual([
			{ code: 'syntax', severity: 'error', message: 'Expected a literal coordinate name; correct the statement before converting it.', line: 1, column: 32, endColumn: 32 },
			{ code: 'syntax', severity: 'error', message: 'Expected \\end{circuitikz}; correct the statement before converting it.', line: 1, column: 32, endColumn: 32 }
		]);
		expect(read('\\begin{circuitikz}').diagnostics).toEqual([{ code: 'syntax', severity: 'error', message: 'Expected \\end{circuitikz}; correct the statement before converting it.', line: 1, column: 19, endColumn: 19 }]);
		expect(read(wrap('\\draw (0,0) -- (1,0)')).diagnostics).toEqual([{ code: 'syntax', severity: 'error', message: 'Expected ; at the end of the statement; correct the statement before converting it.', line: 2, column: 21, endColumn: 21 }]);
	});

	it.each([
		'\\draw[=red] (0,0);',
		'\\draw[color={red] (0,0);', '\\draw[color=$red] (0,0);', '\\draw[color=red}];',
		'\\draw[color=[red]] (0,0);', '\\draw (0,0) to (1,0);',
		'\\draw (0,0) to[=R] (1,0);', '\\coordinate A at (0,0);', '\\coordinate (A.north) at (0,0);',
		'\\coordinate (A at (0,0);', '\\coordinate (A) (0,0);', '\\coordinate (A) at foo;',
		'\\draw (0,0) coordinate (A.north);', '\\draw (0,0) coordinate A;', '\\draw (0,0) -- ((0,0));',
		'\\draw (0,0) -- (0.001,0);', '\\draw (0,0) to[R] (x);', '\\draw (0,0) -- (x);',
		'\\draw (0,0) \\fill {};', '\\draw (0,0) -- (1,0) \\draw (0,0);', '\\node }{a;b};'
		, '\\draw ;', '\\draw (0,0) (bad.anchor);', '\\coordinate ('
		, '\\draw cycle;', '\\coordinate (A) at cycle;'
	])('rejects malformed or unsupported input with no exception: %s', (statement) => {
		const result = read(wrap(statement));
		expect(result.diagnostics.length).toBeGreaterThan(0);
		for (const d of result.diagnostics) expect(d.severity).toBe('error');
	});

	it('rejects malformed environment options before parsing statements', () => {
		expect(read('\\begin{circuitikz}[=x]\\end{circuitikz}').diagnostics).toEqual([{ code: 'syntax', severity: 'error', message: 'Expected an option name before =; correct the statement before converting it.', line: 1, column: 20, endColumn: 21 }]);
	});

	it('ignores empty option entries as pgfkeys does', () => {
		expect(read('\\begin{circuitikz}[]\\end{circuitikz}')).toMatchObject({ diagnostics: [], tree: { keys: [] } });
		expect(read(wrap('\\draw[,thick,] (0,0) to[R,] (1,0) to[] (2,0);'))).toMatchObject({ diagnostics: [], tree: { statements: [{
			keys: [{ name: 'thick' }], elements: [{ kind: 'move' }, { keys: [{ name: 'R' }] }, { keys: [] }] }] } });
	});

	it('skips a statement command inside braces while recovering', () => {
		expect(read(wrap('\\draw (0,0) foo {\\draw (1,1)};\n\\draw (0,0) arc (1,1);')).diagnostics).toEqual([
			{ code: 'unsupported', severity: 'error', message: 'foo is not supported; use the documented CircuiTikZ subset instead.', line: 2, column: 13, endColumn: 16 },
			{ code: 'unsupported', severity: 'error', message: 'arc is not supported; use the documented CircuiTikZ subset instead.', line: 3, column: 13, endColumn: 16 }
		]);
	});

	it('reads a statement command inside option braces as option text', () => {
		expect(read(wrap('\\draw[l={\\draw}] (0,0);')).diagnostics).toEqual([]);
		expect(read(wrap('\\draw[l={\\draw}] (0,0);')).tree?.statements[0]).toMatchObject({ keys: [{ name: 'l' }] });
	});

	describe('a statement left open never swallows the next one', () => {
		const open = [
			'\\draw (0,0) -- (1,0', '\\draw (0,0) -- +(1', '\\draw (0,0', '\\draw (0,0) coordinate (B',
			'\\coordinate (A', '\\coordinate (A) at (0,0', '\\draw[color=red', '\\draw (0,0) to[R'
		];
		const next = [
			{ text: '\\draw (0,0) arc (1,1);', message: 'arc is not supported; use the documented CircuiTikZ subset instead.', column: 13, endColumn: 16 },
			{ text: '\\coordinate (B.north) at (0,0);', message: 'Coordinate name B.north is not supported; use the documented CircuiTikZ subset instead.', column: 14, endColumn: 21 }
		];
		const separators = [{ name: 'LF', text: '\n', line: 3 }, { name: 'CRLF', text: '\r\n', line: 3 }, { name: 'a comment line', text: '\n% between\n', line: 4 }];
		const cases = open.flatMap((broken) => next.flatMap((following) => separators.map((separator) => ({ broken, following, separator }))));
		it.each(cases)('$broken, then $following.text after $separator.name', ({ broken, following, separator }) => {
			const result = read(`\\begin{circuitikz}\n${broken}${separator.text}${following.text}\n\\end{circuitikz}`);
			// The open statement gives exactly one error, on its own line or where the next command starts.
			expect(result.diagnostics).toHaveLength(2);
			expect(result.diagnostics[0]?.code).toBe('syntax');
			expect(result.diagnostics[1]).toEqual({ code: 'unsupported', severity: 'error', message: following.message, line: separator.line, column: following.column, endColumn: following.endColumn });
		});
	});

	it('keeps an unclosed brace group open to the environment end, as TeX groups it', () => {
		// The second \\draw is inside the group, so it is option text, not a statement.
		expect(read(wrap('\\draw[l={x] (0,0);\n\\draw (0,0) arc (1,1);')).diagnostics).toEqual([
			{ code: 'syntax', severity: 'error', message: 'Expected a closing ] with balanced braces and math delimiters; correct the statement before converting it.', line: 4, column: 1, endColumn: 5 }
		]);
	});

	it('resynchronises at the next statement after a missing semicolon', () => {
		expect(read(wrap('\\draw (0,0) -- (1,0)\n\\draw (0,0) -- (x);')).diagnostics).toEqual([
			{ code: 'syntax', severity: 'error', message: 'Expected ; at the end of the statement; correct the statement before converting it.', line: 2, column: 21, endColumn: 21 },
			{ code: 'reference', severity: 'error', message: expect.stringContaining('x'), line: 3, column: 16, endColumn: 19 }
		]);
		expect(read(wrap('\\draw (0,0) -- (1,0)\n\\node {x};')).diagnostics).toEqual([
			{ code: 'syntax', severity: 'error', message: 'Expected ; at the end of the statement; correct the statement before converting it.', line: 2, column: 21, endColumn: 21 },
			{ code: 'unsupported', severity: 'error', message: '\\node is not supported; use the documented CircuiTikZ subset instead.', line: 3, column: 1, endColumn: 6 }
		]);
	});

	it('preserves word boundaries in option keys and values', () => {
		const d = new Diagnostics(false);
		expect(textOf(scan('american resistor=l^', d).slice(0, -1))).toBe('american resistor=l^');
		expect(read(wrap('\\draw (0,0) to[american resistor=100,l^=x] (2,0);')).tree).toMatchObject({ statements: [{ elements: [
			{ kind: 'move' }, { keys: [{ name: 'american resistor' }, { name: 'l^' }] }
		] }] });
	});

	it('enforces statement, path element and component budgets at the boundary', () => {
		const statements = (n: number) => '\\draw (0,0);'.repeat(n);
		expect(read(wrap(statements(LIMITS.statements))).diagnostics).toEqual([]);
		expect(read(wrap(statements(LIMITS.statements + 1))).diagnostics.at(-1)?.message).toBe('The statements limit is 1024; split the circuit across several documents.');
		const paths = (n: number) => '\\draw (0,0)' + ' -- (0,0)'.repeat(n - 1) + ';';
		expect(read(wrap(paths(LIMITS.pathElements))).diagnostics).toEqual([]);
		expect(read(wrap(paths(LIMITS.pathElements + 1))).diagnostics.at(-1)?.message).toBe('The path elements per statement limit is 4096; split the path into several \\draw statements.');
		const components = (n: number) => '\\draw (0,0)' + ' to[R] (1,0)'.repeat(n) + ';';
		expect(read(wrap(components(LIMITS.components))).diagnostics).toEqual([]);
		expect(read(wrap(components(LIMITS.components + 1))).diagnostics.at(-1)?.message).toBe('The components limit is 512; split the circuit across several documents.');
		expect(read(wrap('\\draw (0,0)' + ' to[short] (1,0)'.repeat(LIMITS.components + 1) + ';')).diagnostics).toEqual([]);
	});
});

describe('public M1 API', () => {
	it('sorts diagnostics by position and preserves phase order at identical spans', () => {
		const d = new Diagnostics(false);
		d.add('reference', 'later line', { ...span, line: 2 });
		d.add('unsupported', 'later column', { ...span, column: 2, endColumn: 3 });
		d.add('syntax', 'first phase', span);
		d.add('reference', 'second phase', span);
		expect(d.sorted().map((item) => item.message)).toEqual(['first phase', 'second phase', 'later column', 'later line']);
		expect(d.items[0]?.message).toBe('later line');
	});
	it('returns the documented pending diagnostic, never partial output', () => {
		expect(convertCircuitikz(wrap('\\draw (0,0) -- (2,0);'))).toEqual({ ok: false, source: undefined, fence: undefined, sourceMap: [], diagnostics: [{ code: 'unsupported', severity: 'error', message: 'Conversion is not implemented yet; this milestone validates the supported input syntax only.', line: 1, column: 1, endColumn: 7 }] });
	});

	it('warns only about explicitly documented presentation keys and escalates in strict mode', () => {
		const source = '\\begin{circuitikz}[fixbatteries,color=red]\n\\draw[thick,thin,dashed,mirror,line width=1,-*,*-,*-*,-o,o-,o-o] (0,0);\n\\end{circuitikz}';
		const result = convertCircuitikz(source);
		expect(result.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message)).toEqual([
			'Presentation option color was ignored; schemd draws its own style.',
			...['thick', 'thin', 'dashed', 'mirror', 'line width', '-*', '*-', '*-*', '-o', 'o-', 'o-o'].map((k) => `Presentation option ${k} was ignored; schemd draws its own style.`)
		]);
		const strict = convertCircuitikz(source, { strict: true });
		expect(strict.diagnostics.every((d) => d.severity === 'error')).toBe(true);
		expect(strict.diagnostics).toHaveLength(12);
	});

	it('rejects unknown and malformed options instead of dropping them', () => {
		expect(convertCircuitikz('\\begin{circuitikz}[scale=2,fixbatteries=false,thick=yes,color]\n\\draw[fixbatteries,unknown] (0,0);\n\\end{circuitikz}').diagnostics).toEqual([
			{ code: 'unsupported', severity: 'error', message: 'Option scale is not supported; use the documented CircuiTikZ subset instead.', line: 1, column: 20, endColumn: 25 },
			{ code: 'unsupported', severity: 'error', message: 'Option fixbatteries is not supported; use the documented CircuiTikZ subset instead.', line: 1, column: 28, endColumn: 40 },
			{ code: 'unsupported', severity: 'error', message: 'Option thick is not supported; use the documented CircuiTikZ subset instead.', line: 1, column: 47, endColumn: 52 },
			{ code: 'unsupported', severity: 'error', message: 'Option color is not supported; use the documented CircuiTikZ subset instead.', line: 1, column: 57, endColumn: 62 },
			{ code: 'unsupported', severity: 'error', message: 'Option fixbatteries is not supported; use the documented CircuiTikZ subset instead.', line: 2, column: 7, endColumn: 19 },
			{ code: 'unsupported', severity: 'error', message: 'Option unknown is not supported; use the documented CircuiTikZ subset instead.', line: 2, column: 20, endColumn: 27 }
		]);
	});

	it('is repeatable and keeps conversions independent', () => {
		const input = wrap('\\coordinate (A) at (0,0);');
		const first = convertCircuitikz(input);
		convertCircuitikz(wrap('\\draw (A);'));
		expect(convertCircuitikz(input)).toEqual(first);
		expect(convertCircuitikz(wrap('\\draw (A);')).diagnostics[0]?.code).toBe('reference');
	});

	it('validates options, including symbols and non-enumerable unknown keys', () => {
		expect(optionsOf(undefined)).toEqual({ title: 'Converted CircuiTikZ circuit', strict: false, maxSourceLength: 100_000 });
		expect(optionsOf({ title: 'x'.repeat(120) }).title).toBe('x'.repeat(120));
		expect(optionsOf({ title: 'Exact title', strict: true, maxSourceLength: 1 })).toEqual({ title: 'Exact title', strict: true, maxSourceLength: 1 });
		expect(optionsOf({ maxSourceLength: 1_000_000 }).maxSourceLength).toBe(1_000_000);
		for (const value of [null, [], 'x', 1, true]) expect(() => convertCircuitikz('', value as unknown as ConvertCircuitikzOptions)).toThrow(TypeError);
		for (const title of ['', ' ', 'x'.repeat(121), 1, undefined]) expect(() => convertCircuitikz('', { title } as ConvertCircuitikzOptions)).toThrow('title must be a non-empty string of at most 120 UTF-16 code units.');
		for (const strict of [1, 'true', undefined]) expect(() => convertCircuitikz('', { strict } as unknown as ConvertCircuitikzOptions)).toThrow('strict must be true or false.');
		for (const maxSourceLength of [0, 1_000_001, 1.1, NaN, Infinity, '1', undefined]) expect(() => convertCircuitikz('', { maxSourceLength } as ConvertCircuitikzOptions)).toThrow('maxSourceLength must be an integer from 1 through 1000000.');
		for (const options of [{ other: true }, { [Symbol('x')]: true }, Object.defineProperty({}, 'secret', { value: 1 })]) expect(() => convertCircuitikz('', options)).toThrow('accepted keys are title, strict, maxSourceLength.');
		expect(() => convertCircuitikz(1 as unknown as string)).toThrow('source must be a string containing one circuitikz environment.');
	});

	it('enforces the configured source limit before lexing', () => {
		expect(convertCircuitikz('a', { maxSourceLength: 1 }).diagnostics[0]?.code).toBe('unsupported');
		expect(convertCircuitikz('aa', { maxSourceLength: 1 })).toEqual({ ok: false, source: undefined, fence: undefined, sourceMap: [], diagnostics: [{ code: 'limit', severity: 'error', message: 'The source length limit is 1; convert a shorter document.', line: 1, column: 1, endColumn: 1 }] });
		expect(convertCircuitikz('x'.repeat(LIMITS.sourceLength)).diagnostics[0]?.code).toBe('unsupported');
		expect(convertCircuitikz('x'.repeat(LIMITS.sourceLength + 1)).diagnostics[0]?.code).toBe('limit');
	});

	it('bounds pathological inputs', () => {
		for (const input of ['('.repeat(100_000), '{'.repeat(100_000), '%' + 'x'.repeat(1_000_000), wrap('\\draw (0,0) to[R=' + 'a'.repeat(1_000_000)), wrap('\\draw (0,0);'.repeat(10_000)), '\\begin{circuitikz}']) {
			const result = convertCircuitikz(input);
			expect(result.ok).toBe(false);
			expect(result.sourceMap).toEqual([]);
			expect(result.diagnostics.length).toBeGreaterThan(0);
		}
	}, 2000);
});
