import type { Span, Token } from './ast.js';
import { Diagnostics, limit } from './diagnostics.js';
import { LIMITS } from './limits.js';

/** ASCII control words are TeX commands; all offsets count UTF-16 units. */
export function letter(value: string): boolean {
	return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z';
}

/** Join spans without inventing an end column on a later line. */
export function through(first: Span, last: Span): Span {
	return { start: first.start, end: last.end, line: first.line, column: first.column,
		endColumn: first.line === last.line ? last.endColumn : first.endColumn };
}

/** Literal token text, with each TeX space in a source gap kept as one word boundary. */
export function textOf(tokens: readonly Token[]): string {
	const parts: string[] = [];
	let end = -1;
	for (const token of tokens) {
		if (end >= 0 && token.start > end && token.joined !== true) parts.push(' ');
		parts.push(token.value);
		end = token.end;
	}
	return parts.join('');
}

/** Bounded scanner. Comments and whitespace are consumed once and never emitted. */
export function scan(source: string, diagnostics: Diagnostics): Token[] {
	const tokens: Token[] = [];
	let cursor = 0;
	let line = 1;
	let column = 1;
	let depth = 0;
	// TeX reads a line end as a space unless a comment ended the line, and skips the next line's
	// leading blanks; blanks elsewhere are a space (R-4.1.3).
	let space = false;
	let comment = false;
	let lineStart = false;
	while (cursor < source.length) {
		const c = source[cursor]!;
		if (c === '\r' || c === '\n') {
			cursor += c === '\r' && source[cursor + 1] === '\n' ? 2 : 1;
			line += 1;
			column = 1;
			if (!comment) space = true;
			comment = false;
			lineStart = true;
			continue;
		}
		if (c === ' ' || c === '\t' || c === '\f') { cursor += 1; column += 1; if (!lineStart) space = true; continue; }
		if (c === '%') {
			while (cursor < source.length && source[cursor] !== '\r' && source[cursor] !== '\n') { cursor += 1; column += 1; }
			comment = true;
			continue;
		}
		const start = cursor;
		const startColumn = column;
		let kind: Token['kind'] = 'symbol';
		cursor += 1;
		if (c === '\\') {
			kind = 'command';
			if (letter(source[cursor] ?? '')) {
				while (cursor < source.length && letter(source[cursor]!)) cursor += 1;
			} else if (cursor < source.length && source[cursor] !== '\r' && source[cursor] !== '\n') {
				cursor += source.codePointAt(cursor)! > 0xffff ? 2 : 1;
			}
		} else if ('-- ++ |- -|'.split(' ').includes(source.slice(start, start + 2))) cursor += 1;
		else if (!'{}[](),;=+-|$^*"'.includes(c)) {
			kind = 'atom';
			while (cursor < source.length && !' \t\f\r\n\\%{}[](),;=+-|$^*"'.includes(source[cursor]!)) cursor += 1;
		}
		column += cursor - start;
		const token: Token = { kind, value: source.slice(start, cursor), start, end: cursor, line, column: startColumn, endColumn: column };
		tokens.push(!space && tokens.length > 0 && start > tokens.at(-1)!.end ? { ...token, joined: true } : token);
		space = false;
		comment = false;
		lineStart = false;
		if (c === '{') {
			if (depth === LIMITS.braceDepth) { limit(diagnostics, 'brace nesting depth', LIMITS.braceDepth, 'use fewer nested braces', token); break; }
			depth += 1;
		} else if (c === '}' && depth > 0) depth -= 1;
	}
	tokens.push({ kind: 'eof', value: '', start: cursor, end: cursor, line, column, endColumn: column });
	return tokens;
}
