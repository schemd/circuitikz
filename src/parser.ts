import type { Coordinate, Key, PathElement, Span, Statement, SyntaxTree, Token } from './ast.js';
import { coordinate, isName } from './coordinates.js';
import { Diagnostics, environment, limit, syntax, unsupported } from './diagnostics.js';
import { textOf, through } from './lexer.js';
import { LIMITS } from './limits.js';

/** A statement parser with bounded lookahead and iterative recovery. */
class Parser {
	private cursor = 0;
	private components = 0;
	/** Set when a statement ended at the next statement's command: recovery must not skip it. */
	private synced = false;

	constructor(private readonly tokens: readonly Token[], private readonly diagnostics: Diagnostics,
		private readonly checkOptions: OptionCheck) {}

	private get token(): Token { return this.tokens[this.cursor]!; }
	/** Callers check the EOF boundary before consuming a token. */
	private take(): Token { const token = this.token; this.cursor += 1; return token; }
	private at(value: string): boolean { return this.token.value === value; }
	private accept(value: string): boolean { if (!this.at(value)) return false; this.take(); return true; }
	private expect(value: string): boolean {
		if (this.accept(value)) return true;
		syntax(this.diagnostics, value, this.token); return false;
	}
	private delimiter(command: string): boolean {
		return this.at(command) && this.tokens[this.cursor + 1]?.value === '{'
			&& this.tokens[this.cursor + 2]?.value === 'circuitikz' && this.tokens[this.cursor + 3]?.value === '}';
	}
	private boundary(): boolean { return this.token.kind === 'eof' || this.delimiter('\\end'); }
	/** The next statement's command. A reader stops before it, so a missing delimiter never swallows
	 * the statement after it (R-4.2.3). */
	private statementStart(): boolean { return this.at('\\draw') || this.at('\\coordinate'); }

	/** Skip exactly one broken statement, respecting braces and environment end.
	 * A statement command at depth 0 starts the next statement, so it is never skipped (R-4.2.3). */
	private recover(): void {
		if (this.synced) { this.synced = false; return; }
		let depth = 0;
		while (!this.boundary()) {
			if (depth === 0 && this.statementStart()) return;
			const token = this.take();
			if (token.value === '{') depth += 1;
			else if (token.value === '}') depth = Math.max(0, depth - 1);
			else if (token.value === ';' && depth === 0) return;
		}
	}

	private options(): readonly Key[] | undefined {
		if (!this.accept('[')) return [];
		const keys: Key[] = [];
		let parts: Token[] = [];
		let depth = 0;
		let math = false;
		while (!this.boundary()) {
			const token = this.token;
			if (depth === 0 && !math && (token.value === ',' || token.value === ']')) {
				// pgfkeys ignores empty entries, as in `[]` or `[R,]`.
				if (parts.length === 0) { this.take(); if (token.value === ']') return keys; continue; }
				const equal = parts.findIndex((p) => p.value === '=');
				const nameParts = equal < 0 ? parts : parts.slice(0, equal);
				const name = textOf(nameParts);
				if (name.length === 0) { syntax(this.diagnostics, 'an option name before =', parts[0]!); return undefined; }
				keys.push({ name, value: equal < 0 ? undefined : parts.slice(equal + 1), span: through(nameParts[0]!, nameParts.at(-1)!) });
				parts = [];
				this.take();
				if (token.value === ']') return keys;
				continue;
			}
			if (token.value === '{') depth += 1;
			else if (token.value === '}') {
				if (depth === 0) { syntax(this.diagnostics, 'a matching { before }', token); return undefined; }
				depth -= 1;
			} else if (token.value === '$') math = !math;
			else if (token.value === '[' || depth === 0 && (token.value === ';' || this.statementStart())) break;
			parts.push(this.take());
		}
		syntax(this.diagnostics, 'a closing ] with balanced braces and math delimiters', this.token); return undefined;
	}

	private point(allowCycle = false): Coordinate | undefined {
		const start = this.token;
		if (allowCycle && this.accept('cycle')) return { kind: 'cycle', span: start };
		let mode: 'absolute' | '+' | '++' = 'absolute';
		if (this.at('+') || this.at('++')) mode = this.take().value as '+' | '++';
		if (!this.expect('(')) return undefined;
		const parts: Token[] = [];
		while (!this.boundary() && !this.at(')') && !this.at(';') && !this.at('(') && !this.statementStart()) parts.push(this.take());
		const last = this.token;
		if (!this.expect(')')) return undefined;
		return coordinate(parts, mode, through(start, last), this.diagnostics);
	}

	private name(): { readonly name: string; readonly span: Span } | undefined {
		if (!this.expect('(')) return undefined;
		const parts: Token[] = [];
		while (!this.boundary() && !this.at(')') && !this.at('(') && !this.at(';') && !this.statementStart()) parts.push(this.take());
		if (parts.length === 0) { syntax(this.diagnostics, 'a literal coordinate name', this.token); return undefined; }
		const span = through(parts[0]!, parts.at(-1)!);
		const name = textOf(parts);
		if (!isName(name)) { unsupported(this.diagnostics, `Coordinate name ${name}`, span); return undefined; }
		if (!this.expect(')')) return undefined;
		return { name, span };
	}

	private finish(): boolean {
		if (this.accept(';')) return true;
		const last = this.tokens[this.cursor - 1]!;
		syntax(this.diagnostics, '; at the end of the statement', { ...last, start: last.end, column: last.endColumn });
		return false;
	}

	private statement(): Statement | undefined {
		const start = this.take();
		if (start.value === '\\coordinate') {
			const name = this.name();
			if (name === undefined || !this.expect('at')) return undefined;
			const at = this.point();
			if (at === undefined || !this.finish()) return undefined;
			return { kind: 'coordinate', name: name.name, at, span: name.span };
		}
		if (start.value !== '\\draw') { unsupported(this.diagnostics, start.value, start); return undefined; }
		const keys = this.options();
		if (keys === undefined) return undefined;
		this.checkOptions(keys, false);
		const first = this.point();
		if (first === undefined) return undefined;
		const elements: PathElement[] = [{ kind: 'move', at: first, span: first.span }];
		while (!this.boundary() && !this.at(';')) {
			const operation = this.token;
			if (elements.length === LIMITS.pathElements) { limit(this.diagnostics, 'path elements per statement', LIMITS.pathElements, 'split the path into several \\draw statements', operation); return undefined; }
			if (this.accept('coordinate')) {
				const name = this.name();
				if (name === undefined) return undefined;
				elements.push({ kind: 'name', ...name });
				continue;
			}
			if (this.at('(') || this.at('+') || this.at('++')) {
				const at = this.point();
				if (at === undefined) return undefined;
				elements.push({ kind: 'move', at, span: at.span });
				continue;
			}
			if (!['--', '|-', '-|', 'to'].includes(operation.value)) {
				if (operation.kind === 'command') { this.finish(); this.synced = true; return undefined; }
				unsupported(this.diagnostics, operation.value, operation); return undefined;
			}
			this.take();
			let componentKeys: readonly Key[] = [];
			if (operation.value === 'to') {
				if (!this.at('[')) { unsupported(this.diagnostics, 'to without [...]', operation); return undefined; }
				const parsed = this.options();
				if (parsed === undefined) return undefined;
				componentKeys = parsed;
				if (!parsed.some((key) => key.name === 'short')) {
					if (this.components === LIMITS.components) { limit(this.diagnostics, 'components', LIMITS.components, 'split the circuit across several documents', operation); return undefined; }
					this.components += 1;
				}
			}
			const operationSpan = through(operation, this.tokens[this.cursor - 1]!);
			const at = this.point(true);
			if (at === undefined) return undefined;
			elements.push({ kind: 'segment', operation: operation.value as '--' | '|-' | '-|' | 'to', at, keys: componentKeys, span: operationSpan });
		}
		if (!this.finish()) return undefined;
		return { kind: 'draw', keys, elements, span: start };
	}

	parse(): SyntaxTree | undefined {
		if (!this.delimiter('\\begin')) { environment(this.diagnostics, this.token); return undefined; }
		const span = this.token;
		this.cursor += 4;
		const keys = this.options();
		if (keys === undefined) return undefined;
		this.checkOptions(keys, true);
		const statements: Statement[] = [];
		let count = 0;
		while (!this.boundary()) {
			if (count === LIMITS.statements) { limit(this.diagnostics, 'statements', LIMITS.statements, 'split the circuit across several documents', this.token); return undefined; }
			count += 1;
			const statement = this.statement();
			if (statement === undefined) this.recover();
			else statements.push(statement);
		}
		// Every statement read so far is complete, so later phases still report on it (R-3.4).
		if (!this.delimiter('\\end')) { syntax(this.diagnostics, '\\end{circuitikz}', this.token); return { span, keys, statements }; }
		this.cursor += 4;
		if (this.token.kind !== 'eof') environment(this.diagnostics, this.token);
		return { span, keys, statements };
	}
}

/** Receives each environment or draw option list as soon as it is read, so a statement or document
 * that fails later still has its options checked (R-3.4). */
export type OptionCheck = (keys: readonly Key[], environment: boolean) => void;

/** Parse one environment; all errors are values and recovery always advances. */
export function parse(tokens: readonly Token[], diagnostics: Diagnostics, checkOptions: OptionCheck = () => {}): SyntaxTree | undefined {
	return new Parser(tokens, diagnostics, checkOptions).parse();
}
