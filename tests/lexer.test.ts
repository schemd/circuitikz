import { describe, expect, it } from 'vitest';

import { Diagnostics } from '../src/diagnostics.js';
import { scan } from '../src/lexer.js';
import { LIMITS } from '../src/limits.js';

const span = { start: 0, end: 1, line: 1, column: 1, endColumn: 2 };

describe('scanner', () => {
	it('preserves exact UTF-16 spans and distinguishes escaped comments', () => {
		const d = new Diagnostics();
		expect(scan('α😀\t\\% % discarded\r\n\\draw\rX\nY\fZ', d)).toEqual([
			{ kind: 'atom', value: 'α😀', start: 0, end: 3, line: 1, column: 1, endColumn: 4 },
			{ kind: 'command', value: '\\%', start: 4, end: 6, line: 1, column: 5, endColumn: 7 },
			{ kind: 'command', value: '\\draw', start: 20, end: 25, line: 2, column: 1, endColumn: 6 },
			{ kind: 'atom', value: 'X', start: 26, end: 27, line: 3, column: 1, endColumn: 2 },
			{ kind: 'atom', value: 'Y', start: 28, end: 29, line: 4, column: 1, endColumn: 2 },
			{ kind: 'atom', value: 'Z', start: 30, end: 31, line: 4, column: 3, endColumn: 4 },
			{ kind: 'eof', value: '', start: 31, end: 31, line: 4, column: 4, endColumn: 4 }
		]);
		expect(d.items).toEqual([]);
	});

	it('handles control symbols, bare backslashes and every path operator', () => {
		const d = new Diagnostics();
		expect(scan('\\a \\1 -- ++ |- -| + - | {} \\\n\\', d).map((t) => t.value)).toEqual([
			'\\a', '\\1', '--', '++', '|-', '-|', '+', '-', '|', '{', '}', '\\', '\\', ''
		]);
		expect(scan('% ends at CR\rX', d)[0]).toEqual({ kind: 'atom', value: 'X', start: 13, end: 14, line: 2, column: 1, endColumn: 2 });
		expect(scan('% comment without newline', d)).toEqual([{ kind: 'eof', value: '', start: 25, end: 25, line: 1, column: 26, endColumn: 26 }]);
	});

	it('keeps a control symbol outside the BMP whole', () => {
		const d = new Diagnostics();
		expect(scan('\\😀', d)).toEqual([
			{ kind: 'command', value: '\\😀', start: 0, end: 3, line: 1, column: 1, endColumn: 4 },
			{ kind: 'eof', value: '', start: 3, end: 3, line: 1, column: 4, endColumn: 4 }
		]);
	});

	// TeX drops a comment with its line end, and the next line's leading blanks, so no space is left.
	it.each([
		{ text: 'A% c\nB', joined: true },
		{ text: 'A% c\n  \tB', joined: true },
		{ text: 'A%\n%\nB', joined: true },
		{ text: 'A% c\r\nB', joined: true },
		{ text: 'A % c\nB', joined: false },
		{ text: 'A\nB', joined: false },
		{ text: 'A B', joined: false },
		{ text: 'A% c\n\nB', joined: false }
	])('marks a gap with no TeX space as joined: $text', ({ text, joined }) => {
		const tokens = scan(text, new Diagnostics());
		expect(tokens[1]?.value).toBe('B');
		expect(tokens[1]?.joined === true).toBe(joined);
		expect(tokens[0]?.joined).toBeUndefined();
	});

	it('checks nesting before scanning the rest of hostile input', () => {
		const at = new Diagnostics();
		scan('{'.repeat(LIMITS.braceDepth) + '}'.repeat(LIMITS.braceDepth), at);
		expect(at.items).toEqual([]);
		const over = new Diagnostics();
		const tokens = scan('{'.repeat(100_000), over);
		expect(tokens.length).toBe(LIMITS.braceDepth + 2);
		expect(over.items).toEqual([{ code: 'limit', severity: 'error', message: 'The brace nesting depth limit is 32; use fewer nested braces.', line: 1, column: 33, endColumn: 34 }]);
	});

	it('scans the pathological inputs of R-8.3.4 in linear time', () => {
		const d = new Diagnostics();
		expect(scan('('.repeat(100_000), d)).toHaveLength(100_001);
		expect(scan('%' + 'x'.repeat(1_000_000), d)).toEqual([{ kind: 'eof', value: '', start: 1_000_001, end: 1_000_001, line: 1, column: 1_000_002, endColumn: 1_000_002 }]);
		expect(scan('a'.repeat(1_000_000), d).map((t) => t.end)).toEqual([1_000_000, 1_000_000]);
		expect(d.items).toEqual([]);
	}, 2000);
});

describe('diagnostics', () => {
	it('sorts by position and preserves phase order at identical spans', () => {
		const d = new Diagnostics();
		d.add('reference', 'later line', { ...span, line: 2 });
		d.add('unsupported', 'later column', { ...span, column: 2, endColumn: 3 });
		d.add('syntax', 'first phase', span);
		d.add('reference', 'second phase', span);
		expect(d.sorted().map((item) => item.message)).toEqual(['first phase', 'second phase', 'later column', 'later line']);
		expect(d.items[0]?.message).toBe('later line');
	});
});
