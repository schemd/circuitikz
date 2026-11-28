import { parseMathLabel } from '@schemd/core';
import { describe, expect, it } from 'vitest';

import { convertCircuitikz } from '../src/index.js';
import { segmentsOf } from '../src/convert.js';
import { resolveCoordinates } from '../src/coordinates.js';
import { Diagnostics } from '../src/diagnostics.js';
import { labelOf } from '../src/labels.js';
import { scan } from '../src/lexer.js';
import { parse } from '../src/parser.js';

/**
 * What to[...] means (R-4.4) and what its label becomes (R-4.5), one key at a
 * time and in every combination the requirements rule on.
 */

const PENDING = 'Conversion is not implemented yet; this milestone validates the supported input syntax only.';
const wrap = (keys: string, env = '') => `\\begin{circuitikz}${env}\n\\draw (0,0) to[${keys}] (2,0);\n\\end{circuitikz}`;

/** The part one to[...] resolves to, with every diagnostic its keys raised. */
function specOf(keys: string, env = '', strict = false) {
	const source = wrap(keys, env), d = new Diagnostics(strict);
	const tree = parse(scan(source, d), d)!;
	const fix = tree.keys.some((key) => key.name === 'fixbatteries' && key.value === undefined);
	const [segment] = segmentsOf(resolveCoordinates(tree, d), source, fix, d);
	return { spec: segment!.spec, diagnostics: d.sorted() };
}
const messages = (keys: string) => specOf(keys).diagnostics.map((d) => d.message);
const unsupported = (what: string) => `${what} is not supported; use the documented CircuiTikZ subset instead.`;
const expected = (what: string) => `Expected ${what}; correct the statement before converting it.`;
const presentation = (key: string) => `Presentation option ${key} was ignored; schemd draws its own style.`;

const ALIASES: [string, string, string, string, string, string][] = [
	['R', 'resistor', 'R', 'amber', 'in', 'out'], ['resistor', 'resistor', 'R', 'amber', 'in', 'out'],
	['american resistor', 'resistor', 'R', 'amber', 'in', 'out'], ['european resistor', 'resistor', 'R', 'amber', 'in', 'out'],
	['C', 'capacitor', 'C', 'cyan', 'in', 'out'], ['capacitor', 'capacitor', 'C', 'cyan', 'in', 'out'],
	['L', 'inductor', 'L', 'purple', 'in', 'out'], ['inductor', 'inductor', 'L', 'purple', 'in', 'out'],
	['american inductor', 'inductor', 'L', 'purple', 'in', 'out'], ['cute inductor', 'inductor', 'L', 'purple', 'in', 'out'],
	['european inductor', 'inductor', 'L', 'purple', 'in', 'out'],
	['battery1', 'source', 'B', 'blue', 'positive', 'negative']
];
const LABEL_KEYS = ['NAME', 'l', 'l_', 'l^', 'a', 'a_', 'a^'];

describe('component kinds (R-4.4.1)', () => {
	it.each(ALIASES)('maps %s to %s, prefix %s, %s, from %s to %s', (alias, kind, prefix, color, first, last) => {
		expect(specOf(alias)).toEqual({ diagnostics: [], spec: expect.objectContaining({ kind, prefix, color, first, last, label: undefined, inverted: false }) });
	});

	it.each(ALIASES.map(([alias]) => alias))('takes the label of %s=text and of %s with l=text alike', (alias) => {
		expect(specOf(`${alias}=100`).spec?.label).toBe('100');
		expect(specOf(`${alias},l=100`).spec?.label).toBe('100');
		expect(specOf(`l=100,${alias}`).spec?.label).toBe('100');
	});

	it('gives battery1 the variant core draws it with', () => {
		expect(specOf('battery1').spec).toMatchObject({ variant: 'battery', canonical: 'negative' });
		expect(specOf('R').spec).toMatchObject({ variant: '', canonical: 'in' });
	});

	it.each([['V'], ['I'], ['D'], ['battery'], ['battery2'], ['r'], ['Resistor'], ['generic'], ['open']])('refuses the unknown kind %s, and names no kind for it', (kind) => {
		// Sorted by column: the to[ comes before the key inside it.
		expect(messages(kind)).toEqual([expected('one supported component kind in to[...]'), unsupported(`Option ${kind}`)]);
	});

	it('needs a kind even when every other key is valid', () => {
		expect(specOf('l=x').spec).toBeUndefined();
		expect(messages('l=x,invert')).toEqual([expected('one supported component kind in to[...]')]);
	});

	const kinds = ['R', 'resistor', 'C', 'L', 'battery1', 'short'];
	it.each(kinds.flatMap((a) => kinds.map((b) => [a, b])))('refuses two kinds, %s then %s, at the second', (a, b) => {
		const { diagnostics } = specOf(`${a},${b}`);
		expect(diagnostics).toEqual([expect.objectContaining({ code: 'syntax', message: expected('exactly one component kind in to[...]'), column: 16 + a.length + 1 })]);
	});
});

describe('labels in to[...] (R-4.4.2, R-4.4.5)', () => {
	const keyed = (key: string, text: string) => key === 'NAME' ? `R=${text}` : `R,${key}=${text}`;
	it.each(LABEL_KEYS.flatMap((a) => LABEL_KEYS.filter((b) => b !== 'NAME' || a !== 'NAME').map((b) => [a, b])))('refuses two label keys, %s then %s', (a, b) => {
		const keys = a === 'NAME' ? `R=one,${b}=two` : b === 'NAME' ? `${a}=one,R=two` : `R,${a}=one,${b}=two`;
		const found = messages(keys);
		expect(found.filter((m) => m === expected('exactly one label-bearing option'))).toHaveLength(1);
		// The first label key wins nothing: the part is still refused, and the first is kept for the warning only.
		expect(specOf(keys).spec?.label).toBe('one');
	});

	it.each(LABEL_KEYS.slice(2))('takes %s=text as the label, with a presentation warning, and refuses it in strict mode', (key) => {
		expect(specOf(keyed(key, 'x'))).toEqual({ spec: expect.objectContaining({ label: 'x' }), diagnostics: [expect.objectContaining({ severity: 'warning', message: presentation(key) })] });
		expect(specOf(keyed(key, 'x'), '', true).diagnostics.map((d) => d.severity)).toEqual(['error']);
	});

	it('takes l=text with no warning', () => {
		expect(specOf('R,l=x').diagnostics).toEqual([]);
	});

	it.each(['l', 'l_', 'a'])('refuses %s with no value, which carries no label', (key) => {
		expect(messages(`R,${key}`)).toEqual([unsupported(`Option ${key}`)]);
	});

	it.each(['R=', 'R,l=', 'R=$$', 'R={$$}'])('refuses the empty label %s', (keys) => {
		expect(messages(keys)).toContain(expected('a non-empty label'));
	});
});

describe('invert and fixbatteries (R-4.4.3)', () => {
	it.each([
		['R', '', 'in', 'out'], ['R,invert', '', 'out', 'in'], ['R,invert,invert', '', 'out', 'in'], ['invert,R', '', 'out', 'in'],
		['R', '[fixbatteries]', 'in', 'out'], ['R,invert', '[fixbatteries]', 'out', 'in'],
		['battery1', '', 'positive', 'negative'], ['battery1,invert', '', 'negative', 'positive'], ['battery1,invert,invert', '', 'negative', 'positive'],
		['battery1', '[fixbatteries]', 'negative', 'positive'], ['battery1,invert', '[fixbatteries]', 'positive', 'negative'],
		['battery1,invert,invert', '[fixbatteries]', 'positive', 'negative'], ['battery1', '[fixbatteries,thick]', 'negative', 'positive']
	])('%s in %s starts at %s and ends at %s', (keys, env, start, end) => {
		const { spec } = specOf(keys, env);
		expect(spec!.inverted ? [spec!.last, spec!.first] : [spec!.first, spec!.last]).toEqual([start, end]);
	});

	it.each(['invert=true', 'invert=1', 'invert={}'])('refuses %s, which is not the bare invert flag', (keys) => {
		expect(messages(`R,${keys}`)).toEqual([unsupported('Option invert')]);
	});

	it('takes fixbatteries only bare, and only on the environment', () => {
		expect(convertCircuitikz(wrap('battery1', '[fixbatteries=true]')).diagnostics.map((d) => d.message)).toEqual([unsupported('Option fixbatteries')]);
		expect(messages('battery1,fixbatteries')).toEqual([unsupported('Option fixbatteries')]);
	});
});

describe('short (R-4.4.1)', () => {
	it('is a wire with nothing else to say', () => {
		expect(specOf('short')).toEqual({ spec: expect.objectContaining({ kind: 'wire', prefix: '' }), diagnostics: [] });
	});

	it.each(['short=x', 'short,l=x', 'short,invert', 'short,a=x'])('refuses a label or invert on %s', (keys) => {
		expect(messages(keys)).toContain(unsupported('Labels or invert on short wires'));
	});
});

describe('other keys in to[...] (R-4.4.2, R-5.4)', () => {
	const PRESENTATION = ['mirror', 'thick', 'thin', 'dashed', '-*', '*-', '*-*', '-o', 'o-', 'o-o'];
	it.each(PRESENTATION)('ignores the bare %s with a warning', (key) => {
		expect(specOf(`R,${key}`)).toEqual({ spec: expect.objectContaining({ kind: 'resistor' }), diagnostics: [expect.objectContaining({ severity: 'warning', message: presentation(key) })] });
		expect(specOf(`R,${key}`, '', true).diagnostics.map((d) => d.severity)).toEqual(['error']);
	});

	it.each(PRESENTATION)('refuses %s=value, which is not the presentation key', (key) => {
		expect(messages(`R,${key}=1`)).toEqual([unsupported(`Option ${key}`)]);
	});

	it.each(['color=red', 'line width=1pt'])('ignores %s with a warning', (keys) => {
		expect(specOf(`R,${keys}`).diagnostics.map((d) => d.severity)).toEqual(['warning']);
	});

	it.each(['color', 'line width'])('refuses a bare %s, which has no value to ignore', (key) => {
		expect(messages(`R,${key}`)).toEqual([unsupported(`Option ${key}`)]);
	});

	it.each(['v=2', 'i=1', 'n=a', 'name=a', 'scale=2', 'bipole nodes', 'european', 'f>'])('refuses %s', (keys) => {
		expect(messages(`R,${keys}`)).toEqual([unsupported(`Option ${keys.split('=')[0]}`)]);
	});

	it('reports every refused key, not just the first', () => {
		expect(messages('R,v=2,thick,i=1').map((m) => m.slice(0, 20))).toEqual([unsupported('Option v'), presentation('thick'), unsupported('Option i')].map((m) => m.slice(0, 20)));
	});
});

describe('label text (R-4.5.1 to R-4.5.3)', () => {
	const TEXT = new Set([..."abcxyzABCXYZ0123456789 .,-+/():'"]);
	/* $ opens math, % a comment, \ a command, braces group; , ; [ ] end or break the option list. */
	const STRUCTURE = new Set([...'$%\\{},;[]']);
	const printable = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter((c) => !/[a-zA-Z0-9]/.test(c));

	it.each(printable.filter((c) => !STRUCTURE.has(c)))('text label a%sb is kept or refused by the R-4.5.3 list', (c) => {
		const result = convertCircuitikz(wrap(`R=a${c}b`));
		if (TEXT.has(c)) expect(result.diagnostics.map((d) => d.message)).toEqual([PENDING]);
		else expect(result.diagnostics.map((d) => d.message)).toEqual([unsupported(`Label character ${c}`)]);
	});

	it.each(printable.filter((c) => !STRUCTURE.has(c) || c === ',' || c === ']'))('math label $a%sb$ adds only _ and ^ to the text list', (c) => {
		const result = convertCircuitikz(wrap(`R=$a${c}b$`));
		if (TEXT.has(c) || '_^'.includes(c)) expect(result.diagnostics.map((d) => d.message)).toEqual([PENDING]);
		else expect(result.diagnostics.map((d) => d.message)).toEqual([unsupported(`Label character ${c}`)]);
	});

	it('refuses the double quote, which core\'s DSL cannot escape', () => {
		expect(messages('R="x"')).toEqual([unsupported('Label character "'), unsupported('Label character "')]);
	});

	it.each([
		['100', '100'], ['Bob\'s 100.5 / (2): +', "Bob's 100.5 / (2): +"], ['a  b', 'a b'], ['α', 'α'], ['Ω1', 'Ω1'], ['日本', '日本'],
		['$R_1$', 'R_1'], ['{$R_1$}', 'R_1'], ['$R_{1}^{2}$', 'R_{1}^{2}'], ['$R_{1}\\,\\Omega$', 'R_{1} \\Omega'],
		['$a\\;b\\ c$', 'a b c'], ['$\\mu$', '\\mu'], ['$2\\pi$', '2\\pi']
	])('transcribes %s as %s, adding no units', (text, label) => {
		expect(specOf(`R=${text}`)).toEqual({ spec: expect.objectContaining({ label }), diagnostics: [] });
	});

	const COMMANDS = ['alpha', 'beta', 'Delta', 'cdot', 'infty', 'lambda', 'langle', 'le', 'ge', 'mu', 'neq', 'Omega', 'omega', 'oplus', 'phi', 'pi', 'pm', 'rangle', 'rightarrow', 'sigma', 'sqrt', 'theta', 'times'];
	it.each(COMMANDS)('keeps \\%s in math and refuses it in text', (name) => {
		expect(specOf(`R=$\\${name}$`).spec?.label).toBe(`\\${name}`);
		expect(messages(`R=\\${name}`)).toEqual([unsupported(`Label command \\${name}`)]);
	});

	it.each(['frac', 'mathrm', 'text', 'Alpha', 'ohm', 'SI', 'textbf', 'si'])('refuses \\%s, which core\'s math subset lacks', (name) => {
		expect(messages(`R=$\\${name}$`)).toEqual([unsupported(`Label command \\${name}`)]);
	});

	it.each([['\\,'], ['\\;'], ['\\ ']])('refuses the math space %s outside math', (command) => {
		expect(messages(`R=a${command}b`)).toEqual([unsupported(`Label command ${command}`)]);
	});

	it.each([['a\nb', 'a b'], ['a\rb', 'a b'], ['a\r\nb', 'a b'], ['a\tb', 'a b'], ['a %gone\nb', 'a b'], ['a%gone\n  b', 'ab'], ['a\n\tb', 'a b'],
		['a \n b', 'a b'], ['a%one\n  %two\n  b', 'ab'], ['a%one\r\n b', 'ab'], ['a%one\rb', 'ab'], ['a \t \t b', 'a b']
	])('reads the gap in %j as TeX does, giving %j', (text, label) => {
		// Checked against CircuiTikZ with tectonic: x3a%gone<line end>   b prints x3ab.
		expect(specOf(`R=${text}`).spec?.label).toBe(label);
	});

	it.each([['R=\\alpha\\beta', ['\\alpha', '\\beta']], ['R=$\\frac$', ['\\frac']]])('reports only the refused commands of %s, not an empty label as well', (keys, commands) => {
		expect(messages(keys)).toEqual(commands.map((c) => unsupported(`Label command ${c}`)));
	});

	it('reports a label of refused characters once per character, not as empty', () => {
		expect(messages('R=*?')).toEqual([unsupported('Label character *'), unsupported('Label character ?')]);
	});

	it.each([
		['$R_ 1$', 'R_1', [['text', 'R'], ['subscript', '1']]],
		['$x^ 2$', 'x^2', [['text', 'x'], ['superscript', '2']]],
		['$V_ {out}$', 'V_{out}', [['text', 'V'], ['subscript', 'out']]],
		['$R 1$', 'R1', [['text', 'R1']]],
		['$R\n_1$', 'R_1', [['text', 'R'], ['subscript', '1']]]
	])('drops the blanks TeX ignores in math: %j becomes %j', (text, label, segments) => {
		expect(specOf(`R=${text}`).spec?.label).toBe(label);
		// What core draws from it, segment by segment.
		expect(parseMathLabel(label).map((x) => [x.kind, x.value])).toEqual(segments);
	});

	it.each([
		['$\\mu F$', '\\mu{}F', 'μF'], ['$\\Omega%c\nR$', '\\Omega{}R', 'ΩR'], ['$\\mu\\ F$', '\\mu F', 'μ F'],
		['$\\mu 2$', '\\mu2', 'μ2'], ['$\\mu_1$', '\\mu_1', 'μ1'], ['$\\mu α$', '\\muα', 'μα'], ['$\\pi\\mu$', '\\pi\\mu', 'πμ']
	])('keeps a control word apart from the letter after it: %j becomes %j, drawn %j', (text, label, drawn) => {
		expect(specOf(`R=${text}`).spec?.label).toBe(label);
		expect(parseMathLabel(label).map((x) => x.value).join('')).toBe(drawn);
	});

	it('keeps the blanks of a text label, which TeX prints', () => {
		expect(specOf('R=a b').spec?.label).toBe('a b');
	});

	it('reports a second kind written with a value once, not also as a second label', () => {
		expect(specOf('R=1,C=2').diagnostics).toEqual([expect.objectContaining({ message: expected('exactly one component kind in to[...]'), column: 20 })]);
	});

	it('reads a lone $ as a character, not as empty math', () => {
		const d = new Diagnostics(false), source = '$';
		expect(labelOf(scan(source, d).slice(0, -1), source, d)).toBeUndefined();
		expect(d.items.map((item) => item.message)).toEqual([unsupported('Label character $')]);
	});

	it('reports an empty math label at the dollar sign', () => {
		const d = new Diagnostics(false), source = '$$';
		expect(labelOf(scan(source, d).slice(0, -1), source, d)).toBeUndefined();
		expect(d.items).toEqual([{ code: 'syntax', severity: 'error', message: expected('a non-empty label'), line: 1, column: 1, endColumn: 2 }]);
	});
});
