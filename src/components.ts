import type { Key, Span } from './ast.js';
import { Diagnostics, presentation, syntax, unsupported } from './diagnostics.js';
import { labelOf } from './labels.js';

export interface Definition {
	readonly kind: string;
	readonly prefix: string;
	readonly color: string;
	readonly first: string;
	readonly last: string;
	readonly canonical: string;
	readonly variant: string;
}
export interface PartSpec extends Definition { readonly label: string | undefined; readonly inverted: boolean }

/** CircuiTikZ pgfcircbipoles.tex: resistor/generic, capacitor, inductor and
 * Battery 1; pgfcircpath.tex's inverted xscale. Core ports, not glyph pixels,
 * determine terminal names. M3 extends this same table, never the parser. */
const DEFINITIONS: readonly (readonly [readonly string[], Definition])[] = [
	[['R', 'resistor', 'american resistor', 'european resistor'], { kind: 'resistor', prefix: 'R', color: 'amber', first: 'in', last: 'out', canonical: 'in', variant: '' }],
	[['C', 'capacitor'], { kind: 'capacitor', prefix: 'C', color: 'cyan', first: 'in', last: 'out', canonical: 'in', variant: '' }],
	[['L', 'inductor', 'american inductor', 'cute inductor', 'european inductor'], { kind: 'inductor', prefix: 'L', color: 'purple', first: 'in', last: 'out', canonical: 'in', variant: '' }],
	[['battery1'], { kind: 'source', prefix: 'B', color: 'blue', first: 'positive', last: 'negative', canonical: 'negative', variant: 'battery' }],
	[['short'], { kind: 'wire', prefix: '', color: '', first: '', last: '', canonical: '', variant: '' }]
];

/** Only explicitly enumerated presentation keys are ignored. */
export function presentationKey(key: Key, diagnostics: Diagnostics): boolean {
	if (['mirror', 'thick', 'thin', 'dashed', '-*', '*-', '*-*', '-o', 'o-', 'o-o'].includes(key.name) && key.value === undefined
		|| ['color', 'line width'].includes(key.name) && key.value !== undefined) {
		presentation(diagnostics, key.name, key.span); return true;
	}
	return false;
}

/** Resolve one explicit kind and one label; conflicts are errors, never precedence guesses. */
export function partOf(keys: readonly Key[], source: string, fixBatteries: boolean, span: Span, diagnostics: Diagnostics): PartSpec | undefined {
	let definition: Definition | undefined;
	let label: string | undefined;
	let labelled = false;
	let invert = false;
	for (const key of keys) {
		const found = DEFINITIONS.find(([names]) => names.includes(key.name))?.[1];
		let labelKey = false;
		if (found !== undefined) {
			// A refused second kind is reported once, not also as a second label.
			if (definition !== undefined) syntax(diagnostics, 'exactly one component kind in to[...]', key.span);
			else { definition = found; labelKey = key.value !== undefined; }
		} else if (['l', 'l_', 'l^', 'a', 'a_', 'a^'].includes(key.name) && key.value !== undefined) {
			labelKey = true;
			if (key.name !== 'l') presentation(diagnostics, key.name, key.span);
		} else if (key.name === 'invert' && key.value === undefined) invert = true;
		else if (!presentationKey(key, diagnostics)) unsupported(diagnostics, `Option ${key.name}`, key.span);
		if (labelKey) {
			if (labelled) syntax(diagnostics, 'exactly one label-bearing option', key.span);
			else {
				labelled = true;
				if (key.value!.length === 0) syntax(diagnostics, 'a non-empty label', key.span);
				else label = labelOf(key.value!, source, diagnostics);
			}
		}
	}
	if (definition === undefined) { syntax(diagnostics, 'one supported component kind in to[...]', span); return undefined; }
	if (definition.kind === 'wire' && (labelled || invert)) unsupported(diagnostics, 'Labels or invert on short wires', span);
	const inverted = invert !== (definition.kind === 'source' && fixBatteries);
	return { ...definition, label, inverted };
}
