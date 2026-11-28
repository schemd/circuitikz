/**
 * The mutation gate.
 *
 * Coverage says a line ran; it does not say a test would notice the line being
 * wrong. Each mutant below is a precise substitution in `src` plus the suites
 * that must fail once it is applied, and is named for the *property* it
 * breaks. A surviving mutant fails the gate.
 *
 * Two further rules, checked before anything runs:
 *
 * - `from` must occur exactly once in its file, tabs included, so a mutant
 *   breaks when the code around it is reformatted and someone has to re-read
 *   whether the property still holds.
 * - Every module under `src` carries at least one mutant, except the ones
 *   `EXEMPT` lists, which hold no logic. A new module arrives with its mutants.
 *
 * A mutant no input can tell apart from the original is equivalent: remove it
 * and say why in the pull request.
 *
 * The suites must pass before any mutant is applied. `mutation-run.mjs` gives
 * each run its verdict (R-8.2.1); `tests/mutation-run.test.ts` checks them.
 */
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuites } from './mutation-run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Type declarations and re-exports: nothing a mutant could change. */
const EXEMPT = new Set(['src/ast.ts', 'src/circuit.ts', 'src/index.ts', 'src/types.ts']);

const mutants = [
	{
		name: 'a line end taken by a comment is not a space',
		file: 'src/lexer.ts',
		from: 'if (!comment) space = true;',
		to: 'space = true;',
		tests: ['tests/lexer.test.ts', 'tests/frontend.test.ts']
	},
	{
		name: 'leading blanks after a line end are not a space',
		file: 'src/lexer.ts',
		from: 'if (!lineStart) space = true;',
		to: 'space = true;',
		tests: ['tests/lexer.test.ts', 'tests/frontend.test.ts']
	},
	{
		name: 'blanks before a comment are a space',
		file: 'src/lexer.ts',
		from: 'if (!lineStart) space = true;',
		to: '',
		tests: ['tests/lexer.test.ts', 'tests/frontend.test.ts']
	},
	{
		name: 'a line end after a comment line still counts on the next line',
		file: 'src/lexer.ts',
		from: "comment = false;\n\t\t\tlineStart = true;",
		to: "lineStart = true;",
		tests: ['tests/lexer.test.ts']
	},
	{
		name: 'a joined gap is no word boundary',
		file: 'src/lexer.ts',
		from: 'token.start > end && token.joined !== true',
		to: 'token.start > end',
		tests: ['tests/frontend.test.ts', 'tests/rejections.test.ts']
	},
	{
		name: 'completed statements survive a missing environment end',
		file: 'src/parser.ts',
		from: "this.token); return { span, keys, statements }; }",
		to: "this.token); return undefined; }",
		tests: ['tests/rejections.test.ts']
	},
	{
		name: 'cycle after to[...] is rejected',
		file: 'src/coordinates.ts',
		from: "else if (element.operation === 'to') afterTo = true;",
		to: "else if (element.operation === 'to') afterTo = false;",
		tests: ['tests/frontend.test.ts', 'tests/rejections.test.ts']
	},
	{
		name: 'cycle closes the current subpath',
		file: 'src/coordinates.ts',
		from: 'if (element.kind === \'move\') { first = point;',
		to: 'if (element === statement.elements[0]) { first = point;',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'cycles use the first path point',
		file: 'src/coordinates.ts',
		from: 'if (at.kind === \'cycle\') return first;',
		to: 'if (at.kind === \'cycle\') return base;',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'duplicate names are diagnosed',
		file: 'src/coordinates.ts',
		from: 'if (names.has(name)) reference',
		to: 'if (false) reference',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'plus leaves the relative reference unchanged',
		file: 'src/coordinates.ts',
		from: 'element.at.kind !== \'point\' || element.at.mode !== \'+\'',
		to: 'true',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'relative increments use their reference',
		file: 'src/coordinates.ts',
		from: 'at.x + base.x',
		to: 'at.x',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'relative sums reject overflow',
		file: 'src/coordinates.ts',
		from: '!Number.isSafeInteger(x) || !Number.isSafeInteger(y)',
		to: 'false',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'undefined names keep their precise diagnostic',
		file: 'src/coordinates.ts',
		from: 'if (!names.has(at.name)) reference',
		to: 'if (false) reference',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'a coordinate built on a failed point is still defined',
		file: 'src/coordinates.ts',
		from: 'define(statement.name, resolve(statement.at, base, first), statement.span);',
		to: 'const point = resolve(statement.at, base, first); if (point !== undefined) define(statement.name, point, statement.span);',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'an inline name on a failed point is still defined',
		file: 'src/coordinates.ts',
		from: 'define(element.name, current, element.span);',
		to: 'if (current !== undefined) define(element.name, current, element.span);',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'multiline spans stay on the first line',
		file: 'src/lexer.ts',
		from: 'first.line === last.line ? last.endColumn : first.endColumn',
		to: 'last.endColumn',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'the source limit is inclusive',
		file: 'src/convert.ts',
		from: 'source.length > settings.maxSourceLength',
		to: 'source.length >= settings.maxSourceLength',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'strict escalates presentation warnings',
		file: 'src/diagnostics.ts',
		from: 'warning && !this.strict ? \'warning\' : \'error\'',
		to: 'warning ? \'warning\' : \'error\'',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'coordinate precision is never rounded',
		file: 'src/coordinates.ts',
		from: 'places === 2',
		to: 'places === 3',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'coordinate digits are accumulated in base ten',
		file: 'src/coordinates.ts',
		from: 'value = value * 10 + digit;',
		to: 'value = value * 9 + digit;',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'negative zero is normalized',
		file: 'src/coordinates.ts',
		from: 'negative && magnitude !== 0',
		to: 'negative',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'fractional coordinate overflow is rejected',
		file: 'src/coordinates.ts',
		from: 'value > Math.floor((Number.MAX_SAFE_INTEGER - fraction * (places === 1 ? 10 : 1)) / SCALE)',
		to: 'false',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'every reader stops before a draw or coordinate command',
		file: 'src/parser.ts',
		from: "return this.at('\\\\draw') || this.at('\\\\coordinate');",
		to: "return this.at('\\\\draw');",
		tests: ['tests/rejections.test.ts']
	},
	{
		name: 'a statement command inside braces does not end recovery',
		file: 'src/parser.ts',
		from: 'if (depth === 0 && this.statementStart()) return;',
		to: 'if (this.statementStart()) return;',
		tests: ['tests/frontend.test.ts', 'tests/rejections.test.ts']
	},
	{
		name: 'recovery stops before the next statement command',
		file: 'src/parser.ts',
		from: 'if (depth === 0 && this.statementStart()) return;',
		to: '',
		tests: ['tests/rejections.test.ts']
	},
	{
		name: 'a coordinate stops before the next statement command',
		file: 'src/parser.ts',
		from: "!this.at(';') && !this.at('(') && !this.statementStart())",
		to: "!this.at(';') && !this.at('('))",
		tests: ['tests/rejections.test.ts']
	},
	{
		name: 'a name stops before the next statement command',
		file: 'src/parser.ts',
		from: "!this.at('(') && !this.at(';') && !this.statementStart())",
		to: "!this.at('(') && !this.at(';'))",
		tests: ['tests/rejections.test.ts']
	},
	{
		name: 'an option list stops before the next statement command',
		file: 'src/parser.ts',
		from: "depth === 0 && (token.value === ';' || this.statementStart())",
		to: "depth === 0 && token.value === ';'",
		tests: ['tests/rejections.test.ts']
	},
	{
		name: 'a statement command inside option braces is option text',
		file: 'src/parser.ts',
		from: "depth === 0 && (token.value === ';' || this.statementStart())",
		to: "(token.value === ';' && depth === 0 || this.statementStart())",
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'draw options are checked even when the statement fails',
		file: 'src/parser.ts',
		from: 'this.checkOptions(keys, false);',
		to: '',
		tests: ['tests/rejections.test.ts']
	},
	{
		name: 'environment options are checked even when the document fails',
		file: 'src/parser.ts',
		from: 'this.checkOptions(keys, true);',
		to: '',
		tests: ['tests/rejections.test.ts']
	},
	{
		name: 'recovery stops at the next statement command',
		file: 'src/parser.ts',
		from: 'if (this.synced) { this.synced = false; return; }',
		to: 'this.synced = false;',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'empty option entries are ignored',
		file: 'src/parser.ts',
		from: 'if (parts.length === 0) { this.take(); if (token.value === \']\') return keys; continue; }',
		to: 'if (parts.length === 0) { syntax(this.diagnostics, \'a non-empty option\', token); return undefined; }',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'unknown host options throw',
		file: 'src/options.ts',
		from: 'Reflect.ownKeys(options)',
		to: 'Object.keys(options)',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'strict option types are checked',
		file: 'src/options.ts',
		from: 'typeof value !== \'boolean\'',
		to: 'false',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'title budget is inclusive',
		file: 'src/options.ts',
		from: 'value.length > 120',
		to: 'value.length >= 120',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'recovery ignores semicolons in braces',
		file: 'src/parser.ts',
		from: 'else if (token.value === \';\' && depth === 0) return;',
		to: 'else if (token.value === \';\') return;',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'recovery stops at the environment end',
		file: 'src/parser.ts',
		from: 'private boundary(): boolean { return this.token.kind === \'eof\' || this.delimiter(\'\\\\end\'); }',
		to: 'private boundary(): boolean { return this.token.kind === \'eof\'; }',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'statement budget is inclusive',
		file: 'src/parser.ts',
		from: 'count === LIMITS.statements',
		to: 'count > LIMITS.statements',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'path budget is inclusive',
		file: 'src/parser.ts',
		from: 'elements.length === LIMITS.pathElements',
		to: 'elements.length > LIMITS.pathElements',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'component budget is inclusive',
		file: 'src/parser.ts',
		from: 'this.components === LIMITS.components',
		to: 'this.components > LIMITS.components',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'short is a wire rather than a component',
		file: 'src/parser.ts',
		from: 'if (!parsed.some((key) => key.name === \'short\'))',
		to: 'if (true)',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'component option order and word boundaries survive',
		file: 'src/lexer.ts',
		from: 'if (end >= 0 && token.start > end && token.joined !== true) parts.push(\' \');',
		to: '',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'independent errors are retained',
		file: 'src/parser.ts',
		from: 'if (statement === undefined) this.recover();',
		to: 'if (statement === undefined) { this.recover(); return undefined; }',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'M1 never returns unsupported input as a success',
		file: 'src/convert.ts',
		from: 'ok: false, source: undefined',
		to: 'ok: true, source: undefined',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'missing semicolons are not accepted at environment end',
		file: 'src/parser.ts',
		from: 'if (this.accept(\';\')) return true;',
		to: 'if (this.accept(\';\') || this.boundary()) return true;',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'the default source ceiling is stable',
		file: 'src/limits.ts',
		from: 'sourceLength: 100_000',
		to: 'sourceLength: 100_001',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'one TikZ unit is exactly one hundred integer units',
		file: 'src/limits.ts',
		from: 'export const SCALE = 100;',
		to: 'export const SCALE = 99;',
		tests: ['tests/frontend.test.ts']
	},
	{
		name: 'comments end at CR as well as LF',
		file: 'src/lexer.ts',
		from: "while (cursor < source.length && source[cursor] !== '\\r' && source[cursor] !== '\\n')",
		to: "while (cursor < source.length && source[cursor] !== '\\n')",
		tests: ['tests/lexer.test.ts']
	},
	{
		name: 'columns count UTF-16 units',
		file: 'src/lexer.ts',
		from: 'column += cursor - start;',
		to: 'column += [...source.slice(start, cursor)].length;',
		tests: ['tests/lexer.test.ts']
	},
	{
		name: 'CRLF is one newline',
		file: 'src/lexer.ts',
		from: "c === '\\r' && source[cursor + 1] === '\\n' ? 2 : 1",
		to: '1',
		tests: ['tests/lexer.test.ts']
	},
	{
		name: 'escaped percent does not begin a comment',
		file: 'src/lexer.ts',
		from: "kind = 'command';",
		to: "if (source[cursor] === '%') { cursor = source.length; } kind = 'command';",
		tests: ['tests/lexer.test.ts']
	},
	{
		name: 'a control symbol takes a whole code point',
		file: 'src/lexer.ts',
		from: 'cursor += source.codePointAt(cursor)! > 0xffff ? 2 : 1;',
		to: 'cursor += 1;',
		tests: ['tests/lexer.test.ts']
	},
	{
		name: 'the scan stops at the brace ceiling',
		file: 'src/lexer.ts',
		from: "LIMITS.braceDepth, 'use fewer nested braces', token); break; }",
		to: "LIMITS.braceDepth, 'use fewer nested braces', token); }",
		tests: ['tests/lexer.test.ts']
	},
	{
		name: 'the brace nesting ceiling is 32',
		file: 'src/limits.ts',
		from: 'braceDepth: 32',
		to: 'braceDepth: 33',
		tests: ['tests/lexer.test.ts']
	},
	{
		name: 'diagnostics sort by line then column',
		file: 'src/diagnostics.ts',
		from: 'a.line - b.line || a.column - b.column',
		to: 'b.line - a.line || a.column - b.column',
		tests: ['tests/lexer.test.ts']
	},
	{
		name: 'a junction is recognised by its kind',
		file: 'src/topology.ts',
		from: "netlist.nodes.filter((node) => node.kind === 'junction')",
		to: "netlist.nodes.filter((node) => node.kind === 'port')",
		tests: ['tests/topology.test.ts', 'tests/conformance.test.ts']
	},
	{
		name: 'junction terminals are left out of the circuit',
		file: 'src/topology.ts',
		from: 'net.terminals.filter((terminal) => !junctions.has(terminal.componentId))',
		to: 'net.terminals.filter(() => true)',
		tests: ['tests/topology.test.ts', 'tests/conformance.test.ts']
	},
	{
		name: 'a terminal written twice on a net counts once',
		file: 'src/topology.ts',
		from: '.map((net) => [...new Set(net)].sort(compare))',
		to: '.map((net) => [...net].sort(compare))',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'a net with no terminal is dropped',
		file: 'src/topology.ts',
		from: '.filter((net) => net.length > 0)',
		to: '.filter(() => true)',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'terminals sort by code unit, not locale',
		file: 'src/topology.ts',
		from: 'return left < right ? -1 : left > right ? 1 : 0;',
		to: 'return left.localeCompare(right);',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'nets sort by their whole contents',
		file: 'src/topology.ts',
		from: "compare(left.join('\\n'), right.join('\\n'))",
		to: 'compare(left[0]!, right[0]!)',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'two spellings of one circuit compare equal',
		file: 'src/topology.ts',
		from: 'for (const net of canonical(nets))',
		to: 'for (const net of nets)',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'a terminal that lost its connection is named as such',
		file: 'src/topology.ts',
		from: 'if (other === undefined) return',
		to: 'if (false) return',
		tests: ['tests/topology.test.ts']
	},
	{
		name: 'a terminal on the wrong net is a difference',
		file: 'src/topology.ts',
		from: 'if (other !== net) return',
		to: 'if (false) return',
		tests: ['tests/topology.test.ts', 'tests/conformance.test.ts']
	},
	{
		name: 'a connection the TeX never made is a difference',
		file: 'src/topology.ts',
		from: 'if (!wanted.has(terminal)) return',
		to: 'if (false) return',
		tests: ['tests/topology.test.ts']
	},
	{
		name: `a second component kind is refused`,
		file: 'src/components.ts',
		from: `if (definition !== undefined) syntax(`,
		to: `if (false) syntax(`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `NAME=text carries a label`,
		file: 'src/components.ts',
		from: `labelKey = key.value !== undefined;`,
		to: `labelKey = false;`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `only l takes a label without a warning`,
		file: 'src/components.ts',
		from: `if (key.name !== 'l') presentation(`,
		to: `if (false) presentation(`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `invert must be bare`,
		file: 'src/components.ts',
		from: `key.name === 'invert' && key.value === undefined`,
		to: `key.name === 'invert'`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `repeated invert never toggles back`,
		file: 'src/components.ts',
		from: `key.value === undefined) invert = true;`,
		to: `key.value === undefined) invert = !invert;`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a second label key is refused`,
		file: 'src/components.ts',
		from: `if (labelled) syntax(`,
		to: `if (false) syntax(`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a part needs a kind`,
		file: 'src/components.ts',
		from: `if (definition === undefined) { syntax(diagnostics, 'one supported component kind in to[...]', span); return undefined; }`,
		to: `if (definition === undefined) return undefined;`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `short takes no label or invert`,
		file: 'src/components.ts',
		from: `if (definition.kind === 'wire' && (labelled || invert))`,
		to: `if (false)`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `fixbatteries turns only batteries`,
		file: 'src/components.ts',
		from: `invert !== (definition.kind === 'source' && fixBatteries)`,
		to: `invert !== fixBatteries`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `fixbatteries turns batteries`,
		file: 'src/components.ts',
		from: `invert !== (definition.kind === 'source' && fixBatteries)`,
		to: `invert`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a presentation flag with a value is not presentation`,
		file: 'src/components.ts',
		from: `'o-o'].includes(key.name) && key.value === undefined`,
		to: `'o-o'].includes(key.name)`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `color and line width need a value`,
		file: 'src/components.ts',
		from: `['color', 'line width'].includes(key.name) && key.value !== undefined`,
		to: `['color', 'line width'].includes(key.name)`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `every documented alias is a kind`,
		file: 'src/components.ts',
		from: `'american resistor', 'european resistor'`,
		to: `'american resistor'`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `battery1 starts at its positive plate`,
		file: 'src/components.ts',
		from: `first: 'positive', last: 'negative'`,
		to: `first: 'negative', last: 'positive'`,
		tests: ['tests/components.test.ts', 'tests/graph.test.ts']
	},
	{
		name: `each kind keeps its colour`,
		file: 'src/components.ts',
		from: `color: 'purple'`,
		to: `color: 'amber'`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `{$...$} is math too`,
		file: 'src/labels.ts',
		from: `if (parts[0]?.value === '{'`,
		to: `if (false`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a lone $ is not math`,
		file: 'src/labels.ts',
		from: `&& parts.length > 1;`,
		to: `;`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `label commands are math only`,
		file: 'src/labels.ts',
		from: `else if (math && COMMANDS.has(`,
		to: `else if (COMMANDS.has(`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `braces, _ and ^ are math only`,
		file: 'src/labels.ts',
		from: `|| math && '{}_^'.includes(c)`,
		to: `|| '{}_^'.includes(c)`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a double quote is never a label character`,
		file: 'src/labels.ts',
		from: `" .,-+/():'".includes(c)`,
		to: `" .,-+/():'\\"".includes(c)`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a comment takes its line end with it`,
		file: 'src/labels.ts',
		from: `if (!comment) space = true; comment = false; lineStart = true;`,
		to: `space = true; comment = false; lineStart = true;`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a line's leading blanks are skipped`,
		file: 'src/labels.ts',
		from: `else if (!comment && !lineStart) space = true;`,
		to: `else if (!comment) space = true;`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `CRLF is one line end in a label`,
		file: 'src/labels.ts',
		from: `if (c === '\\r' && source[i + 1] === '\\n') i += 1;`,
		to: ``,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a refused label is not also empty`,
		file: 'src/labels.ts',
		from: `if (!refused) syntax(`,
		to: `syntax(`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a wire that closes a cycle adds no link`,
		file: 'src/graph.ts',
		from: `if (nets.join(from, to)) links.push(`,
		to: `nets.join(from, to); links.push(`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a diagonal part is refused`,
		file: 'src/graph.ts',
		from: `dx !== 0 && dy !== 0 || Math.abs(dx)`,
		to: `Math.abs(dx)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a part is at least 0.84 units long`,
		file: 'src/graph.ts',
		from: `Math.abs(dy) < 84)`,
		to: `Math.abs(dy) < 83)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `IDs count per prefix`,
		file: 'src/graph.ts',
		from: `const count = (counts.get(spec.prefix) ?? 0) + 1;`,
		to: `const count = parts.length + 1;`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `invert swaps the start terminal`,
		file: 'src/graph.ts',
		from: `first: spec.inverted ? spec.last : spec.first`,
		to: `first: spec.first`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `the canvas limit is inclusive`,
		file: 'src/graph.ts',
		from: `if (width > SCHEMATIC_LIMITS.maximumBound`,
		to: `if (width >= SCHEMATIC_LIMITS.maximumBound`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `the canvas has a height limit`,
		file: 'src/graph.ts',
		from: `|| height > SCHEMATIC_LIMITS.maximumBound)`,
		to: `)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `the margin is part of the canvas`,
		file: 'src/graph.ts',
		from: `const width = maxX - minX + 2 * MARGIN`,
		to: `const width = maxX - minX`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `touching segments do not overlap`,
		file: 'src/graph.ts',
		from: `if (item.low < high)`,
		to: `if (item.low <= high)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `an overlap is found past a contained segment`,
		file: 'src/graph.ts',
		from: `high = Math.max(high, item.high);`,
		to: `high = item.high;`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a reversed segment lies on the same line`,
		file: 'src/graph.ts',
		from: `if (dx < 0 || dx === 0 && dy < 0) { dx = -dx; dy = -dy; }`,
		to: ``,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `segments of different lengths share a direction`,
		file: 'src/graph.ts',
		from: `dx /= a; dy /= a;`,
		to: ``,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `three edge ends make a junction`,
		file: 'src/graph.ts',
		from: `if (v.degree < 3) continue;`,
		to: `if (v.degree < 4) continue;`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `the junction budget is inclusive`,
		file: 'src/graph.ts',
		from: `if (junctions.length === LIMITS.junctions)`,
		to: `if (junctions.length === LIMITS.junctions - 1)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a circuit of junctions alone is not empty`,
		file: 'src/graph.ts',
		from: `if (parts.length + junctions.length === 0)`,
		to: `if (parts.length === 0)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a wire on no anchor is refused`,
		file: 'src/graph.ts',
		from: `if (edge.wire && !hasAnchor.has(`,
		to: `if (false && !hasAnchor.has(`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a dropped cycle edge leaves no dead end`,
		file: 'src/graph.ts',
		from: `wire !== undefined && vertices[at]!.degree === 1 && !ambiguous)`,
		to: `wire !== undefined && !ambiguous)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `ambiguous geometry hides the stubs it leaves`,
		file: 'src/graph.ts',
		from: `vertices[at]!.degree === 1 && !ambiguous)`,
		to: `vertices[at]!.degree === 1)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `ambiguous geometry hides the orphans it leaves`,
		file: 'src/graph.ts',
		from: `if (!ambiguous) for (const edge of links)`,
		to: `for (const edge of links)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a chain runs the way its earliest wire was drawn`,
		file: 'src/graph.ts',
		from: `const earliest = wires.reduce((a, b) => a.edge.order < b.edge.order ? a : b);`,
		to: `const earliest = wires[0]!;`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a direct junction contact follows the part's direction`,
		file: 'src/graph.ts',
		from: `forward = anchor.order < 0 ? other.start : true;`,
		to: `forward = true;`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `connections are in source order`,
		file: 'src/graph.ts',
		from: `connections.sort((a, b) => a.order - b.order);`,
		to: ``,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a connection takes the colour of its start`,
		file: 'src/graph.ts',
		from: `color: forward ? anchor.color : other.color`,
		to: `color: anchor.color`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `|- turns at the vertical first`,
		file: 'src/convert.ts',
		from: `segment.operation === '|-' ? { x: segment.from.x, y: segment.to.y }`,
		to: `segment.operation === '-|' ? { x: segment.from.x, y: segment.to.y }`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `no graph after an earlier error`,
		file: 'src/convert.ts',
		from: `if (!diagnostics.items.some((item) => item.severity === 'error')) buildCircuit(`,
		to: `buildCircuit(`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a vertex keeps the span of the point that made it`,
		file: 'src/coordinates.ts',
		from: `currentSpan = element.at.span;`,
		to: ``,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `the junction ceiling is stable`,
		file: 'src/limits.ts',
		from: `junctions: 512,`,
		to: `junctions: 511,`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `math spacing commands are spaces`,
		file: 'src/labels.ts',
		from: `if (math && ['\\\\,', '\\\\;', '\\\\ '].includes(token.value)) { output.push(' '); word = false; }`,
		to: `if (false) { output.push(' '); word = false; }`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a math space ends a control word`,
		file: 'src/labels.ts',
		from: `{ output.push(' '); word = false; }`,
		to: `output.push(' ');`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `TeX ignores blanks in math`,
		file: 'src/labels.ts',
		from: `if (space && !math) output.push(' ');`,
		to: `if (space) output.push(' ');`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a control word is kept apart from the next letter`,
		file: 'src/labels.ts',
		from: `if (word && /[A-Za-z]/.test(c)) output.push('{}');`,
		to: ``,
		tests: ['tests/components.test.ts']
	},
	{
		name: `only an ASCII letter continues a control word`,
		file: 'src/labels.ts',
		from: `if (word && /[A-Za-z]/.test(c))`,
		to: `if (word)`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a refused second kind is not also a second label`,
		file: 'src/components.ts',
		from: `else { definition = found; labelKey = key.value !== undefined; }`,
		to: `else definition = found; labelKey = key.value !== undefined;`,
		tests: ['tests/components.test.ts']
	},
	{
		name: `a zero-length wire is no branch and no vertex`,
		file: 'src/graph.ts',
		from: `if ((segment.spec === undefined || segment.spec.kind === 'wire') && segment.from.x === segment.to.x && segment.from.y === segment.to.y) continue;`,
		to: ``,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `a zero-length wire is only one with equal ends`,
		file: 'src/graph.ts',
		from: `segment.from.x === segment.to.x && segment.from.y === segment.to.y) continue;`,
		to: `segment.from.x === segment.to.x) continue;`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `the canvas limit is stated in TikZ units`,
		file: 'src/graph.ts',
		from: `(SCHEMATIC_LIMITS.maximumBound - 2 * MARGIN) / SCALE`,
		to: `(SCHEMATIC_LIMITS.maximumBound - 2 * MARGIN)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `an overlap hides its endpoints`,
		file: 'src/graph.ts',
		from: `if (overlapping) return true;`,
		to: ``,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `an endpoint inside a segment is ambiguous geometry`,
		file: 'src/graph.ts',
		from: `	return inside;`,
		to: `	return false;`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `an endpoint at the start of a segment is not inside it`,
		file: 'src/graph.ts',
		from: `if (group[middle]!.low < at)`,
		to: `if (group[middle]!.low <= at)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `an endpoint at the end of a segment is not inside it`,
		file: 'src/graph.ts',
		from: `at < group[low - 1]!.high`,
		to: `at <= group[low - 1]!.high`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `the search looks left of the insertion point`,
		file: 'src/graph.ts',
		from: `if (low > 0 && at < group[low - 1]!.high)`,
		to: `if (low < group.length && at < group[low]!.high)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `an endpoint is reported once`,
		file: 'src/graph.ts',
		from: `inside = true; break; }`,
		to: `inside = true; }`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `the direction budget is inclusive`,
		file: 'src/graph.ts',
		from: `if (lines.size === LIMITS.directions)`,
		to: `if (lines.size === LIMITS.directions + 1)`,
		tests: ['tests/graph.test.ts']
	},
	{
		name: `the direction ceiling is stable`,
		file: 'src/limits.ts',
		from: `directions: 64,`,
		to: `directions: 63,`,
		tests: ['tests/graph.test.ts']
	}
];

async function sourceFiles(directory) {
	const entries = await readdir(join(root, directory), { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => (entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : [join(directory, entry.name)]))
	);
	return files.flat().filter((file) => file.endsWith('.ts'));
}

const mutated = new Set(mutants.map((mutant) => mutant.file));
const unguarded = (await sourceFiles('src')).map((file) => relative(root, join(root, file))).filter((file) => !EXEMPT.has(file) && !mutated.has(file));
if (unguarded.length > 0) throw new Error(`Modules with no mutant: ${unguarded.join(', ')}. Add one, or list a logic-free module in EXEMPT.`);
const names = new Set(mutants.map((mutant) => mutant.name));
if (names.size !== mutants.length) throw new Error('Two mutants share a name; each names one property.');

const sandbox = await mkdtemp(join(tmpdir(), 'schemd-circuitikz-mutation-'));
try {
	for (const path of ['src', 'tests']) await cp(join(root, path), join(sandbox, path), { recursive: true });
	for (const path of ['package.json', 'tsconfig.json', 'vitest.config.ts']) await cp(join(root, path), join(sandbox, path));
	await symlink(join(root, 'node_modules'), join(sandbox, 'node_modules'), 'dir');
	const survivors = [];
	const baseline = await runSuites(sandbox, [...new Set(mutants.flatMap((mutant) => mutant.tests))]);
	if (baseline.verdict !== 'passed') throw new Error(`Mutation baseline is not green (${baseline.verdict}); fix the tests first.\n${baseline.output}`);

	for (const mutant of mutants) {
		const path = join(sandbox, mutant.file);
		const original = await readFile(join(root, mutant.file), 'utf8');
		const first = original.indexOf(mutant.from);
		if (first < 0 || original.indexOf(mutant.from, first + mutant.from.length) >= 0) {
			throw new Error(`Mutation target must occur exactly once: ${mutant.name}`);
		}
		await writeFile(path, original.replace(mutant.from, mutant.to));
		let result;
		try {
			result = await runSuites(sandbox, mutant.tests);
		} finally {
			await writeFile(path, original);
		}
		if (result.verdict === 'passed') {
			survivors.push({ mutant, output: result.output });
			console.error(`SURVIVED  ${mutant.name}`);
		} else {
			console.log(`${result.verdict === 'timeout' ? 'TIMEOUT ' : 'KILLED  '}  ${mutant.name}`);
		}
	}

	if (survivors.length > 0) {
		for (const { mutant, output } of survivors) console.error(`\n--- ${mutant.name} ---\n${output.trim()}`);
		process.exitCode = 1;
	} else {
		console.log(`\nMutation score: 100% (${mutants.length}/${mutants.length} killed)`);
	}
} finally {
	await rm(sandbox, { recursive: true, force: true });
}
