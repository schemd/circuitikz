import type { Token } from './ast.js';
import { Diagnostics, syntax, unsupported } from './diagnostics.js';

/** The public core 1.1 micro-math command inventory (src/math-label.ts). */
const COMMANDS = new Set(['alpha', 'beta', 'Delta', 'cdot', 'infty', 'lambda', 'langle', 'le', 'ge', 'mu', 'neq', 'Omega', 'omega', 'oplus', 'phi', 'pi', 'pm', 'rangle', 'rightarrow', 'sigma', 'sqrt', 'theta', 'times']);

/** Validate before quoting: core's DSL has no escaped-double-quote production. */
export function labelOf(tokens: readonly Token[], source: string, diagnostics: Diagnostics): string | undefined {
	let parts = tokens;
	if (parts[0]?.value === '{' && parts[1]?.value === '$' && parts.at(-2)?.value === '$' && parts.at(-1)?.value === '}') parts = parts.slice(1, -1);
	const math = parts[0]?.value === '$' && parts.at(-1)?.value === '$' && parts.length > 1;
	if (math) parts = parts.slice(1, -1);
	const output: string[] = [];
	let refused = false, word = false;
	let previous: Token | undefined;
	for (const token of parts) {
		if (previous !== undefined) {
			// TeX's reading rules: a run of blanks and line ends is one space, a line's
			// leading blanks are skipped, and a comment takes its line end with it.
			let comment = false, lineStart = false, space = false;
			for (let i = previous.end; i < token.start; i += 1) {
				const c = source[i]!;
				if (c === '%') comment = true;
				else if (c === '\n' || c === '\r') { if (!comment) space = true; comment = false; lineStart = true; if (c === '\r' && source[i + 1] === '\n') i += 1; }
				else if (!comment && !lineStart) space = true;
			}
			// TeX ignores blanks in math; core would draw them.
			if (space && !math) output.push(' ');
		}
		previous = token;
		if (token.kind === 'command') {
			if (math && ['\\,', '\\;', '\\ '].includes(token.value)) { output.push(' '); word = false; }
			else if (math && COMMANDS.has(token.value.slice(1))) { output.push(token.value); word = true; }
			else { unsupported(diagnostics, `Label command ${token.value}`, token); refused = true; }
			continue;
		}
		for (const c of token.value) {
			if (/[\p{L}\p{N}]/u.test(c) || " .,-+/():'".includes(c) || math && '{}_^'.includes(c)) {
				// Core reads a control word up to the next non-letter: \mu then F must not become \muF.
				if (word && /[A-Za-z]/.test(c)) output.push('{}');
				output.push(c); word = false;
			}
			else { unsupported(diagnostics, `Label character ${c}`, token); refused = true; }
		}
	}
	// A label left empty only because its content was refused is not also an empty label.
	if (output.length === 0) { if (!refused) syntax(diagnostics, 'a non-empty label', tokens[0]!); return undefined; }
	return output.join('');
}
