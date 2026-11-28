import type { Point, Span } from './ast.js';
import type { PartSpec } from './components.js';
import type { CircuitConnectivity } from './types.js';

export interface Segment { readonly from: Point; readonly to: Point; readonly fromSpan: Span; readonly toSpan: Span; readonly span: Span; readonly spec: PartSpec | undefined }
export interface Part { readonly id: string; readonly spec: PartSpec; readonly from: number; readonly to: number; readonly first: string; readonly last: string; readonly span: Span }
export interface Vertex extends Point { readonly span: Span; readonly degree: number }
export interface Junction { readonly id: string; readonly vertex: number; readonly span: Span }
export interface Connection { readonly from: string; readonly to: string; readonly color: string; readonly span: Span; readonly order: number }
export interface Circuit {
	readonly vertices: readonly Vertex[];
	readonly parts: readonly Part[];
	readonly junctions: readonly Junction[];
	readonly connections: readonly Connection[];
	readonly expected: CircuitConnectivity;
	readonly bounds: { readonly minX: number; readonly maxY: number; readonly width: number; readonly height: number };
}
