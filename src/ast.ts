/** Internal syntax and resolved geometry, independent of Schemd text. All offsets count UTF-16 units. */
export interface Span {
	readonly start: number;
	readonly end: number;
	readonly line: number;
	readonly column: number;
	readonly endColumn: number;
}

export interface Token extends Span {
	readonly value: string;
	readonly kind: 'command' | 'atom' | 'symbol' | 'eof';
	/** Set when the gap before this token holds no TeX space: only comments, with the line ends
	 * and leading blanks they swallow. */
	readonly joined?: true;
}

export interface Key {
	readonly name: string;
	readonly value: readonly Token[] | undefined;
	readonly span: Span;
}

export type Coordinate =
	{ readonly kind: 'point'; readonly x: number; readonly y: number; readonly mode: 'absolute' | '+' | '++'; readonly span: Span }
	| { readonly kind: 'reference'; readonly name: string; readonly span: Span }
	| { readonly kind: 'cycle'; readonly span: Span };

export type PathElement =
	{ readonly kind: 'move'; readonly at: Coordinate; readonly span: Span }
	| { readonly kind: 'segment'; readonly operation: '--' | '|-' | '-|' | 'to'; readonly at: Coordinate; readonly keys: readonly Key[]; readonly span: Span }
	| { readonly kind: 'name'; readonly name: string; readonly span: Span };

export type Statement =
	{ readonly kind: 'draw'; readonly elements: readonly PathElement[]; readonly keys: readonly Key[]; readonly span: Span }
	| { readonly kind: 'coordinate'; readonly name: string; readonly at: Coordinate; readonly span: Span };

export interface SyntaxTree {
	readonly span: Span;
	readonly keys: readonly Key[];
	readonly statements: readonly Statement[];
}

export interface Point {
	readonly x: number;
	readonly y: number;
}

export interface ResolvedSegment {
	readonly from: Point;
	readonly to: Point;
	readonly operation: '--' | '|-' | '-|' | 'to';
	readonly keys: readonly Key[];
	readonly span: Span;
}
