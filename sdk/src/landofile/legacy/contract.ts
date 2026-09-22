/**
 * Node model for the source-preserving `LEGACY` Landofile parse mode.
 *
 * `LEGACY` reads the Lando 3 dialect for translation: quoted and block
 * scalars, populated flow collections, anchors, bounded aliases, and arbitrary
 * tags kept as data. Every node records where it came from so a translator can
 * point a diagnostic at the exact source text. The v4 parse path in
 * `../parser.ts` is untouched by this model and keeps its own restrictions.
 */

// ==== Source positions ====
// 1-based line/column to match `LandofileParseError`; 0-based UTF-16 offsets
// index the parsed `content` string directly, so `content.slice(start.offset,
// end.offset)` is the node's source text. `end` is exclusive.

export interface LegacySourcePosition {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export interface LegacySourceSpan {
  readonly start: LegacySourcePosition;
  readonly end: LegacySourcePosition;
}

// ==== Nodes ====
// Scalar `text` is already decoded: quotes removed, escapes applied, block
// scalars folded and chomped. Typing a plain scalar to null/boolean/number is
// a projection concern, so the tree stays lossless.

export type LegacyScalarStyle = "plain" | "single" | "double" | "literal" | "folded";

export interface LegacyScalarNode {
  readonly kind: "scalar";
  readonly style: LegacyScalarStyle;
  readonly text: string;
  readonly tag: string | undefined;
  readonly anchor: string | undefined;
  readonly span: LegacySourceSpan;
}

export interface LegacyMappingEntry {
  readonly key: LegacyScalarNode;
  readonly value: LegacyNode;
  readonly span: LegacySourceSpan;
}

export interface LegacyMappingNode {
  readonly kind: "mapping";
  readonly entries: ReadonlyArray<LegacyMappingEntry>;
  readonly tag: string | undefined;
  readonly anchor: string | undefined;
  readonly span: LegacySourceSpan;
}

export interface LegacySequenceNode {
  readonly kind: "sequence";
  readonly items: ReadonlyArray<LegacyNode>;
  readonly tag: string | undefined;
  readonly anchor: string | undefined;
  readonly span: LegacySourceSpan;
}

export interface LegacyAliasNode {
  readonly kind: "alias";
  readonly name: string;
  readonly span: LegacySourceSpan;
}

export type LegacyNode = LegacyScalarNode | LegacyMappingNode | LegacySequenceNode | LegacyAliasNode;

// ==== Tagged data ====
// A tag is retained rather than resolved: `!load ./x.sh` projects to a marker
// carrying the tag, the tagged value, and its span. Nothing in this mode reads
// a referenced file.

export const LEGACY_TAGGED: unique symbol = Symbol.for("@lando/sdk/landofile/legacy-tagged");

export interface LegacyTagged {
  readonly [LEGACY_TAGGED]: true;
  readonly tag: string;
  readonly value: unknown;
  readonly span: LegacySourceSpan;
}

export const makeLegacyTagged = (tag: string, value: unknown, span: LegacySourceSpan): LegacyTagged => ({
  [LEGACY_TAGGED]: true,
  tag,
  value,
  span,
});

export const isLegacyTagged = (value: unknown): value is LegacyTagged =>
  typeof value === "object" && value !== null && LEGACY_TAGGED in value;

/** Where a tag occurred, keyed by the projected path that carries it. */
export interface LegacyTagOccurrence {
  readonly tag: string;
  readonly span: LegacySourceSpan;
  readonly path: ReadonlyArray<string | number>;
}

// ==== Parse surface ====

export interface LegacyParseLimits {
  readonly maxContentBytes?: number;
  readonly maxDepth?: number;
  readonly maxAliases?: number;
}

/**
 * `mode` is a required literal: `LEGACY` is never a default a v4 caller can
 * fall into, it is a parse the caller asked for by name.
 */
export interface LegacyParseOptions {
  readonly mode: "legacy";
  readonly file: string;
  readonly content: string;
  readonly limits?: LegacyParseLimits;
}

export interface LegacyDocument {
  readonly mode: "legacy";
  readonly file: string;
  readonly root: LegacyNode | null;
  readonly value: unknown;
  readonly tags: ReadonlyArray<LegacyTagOccurrence>;
}

/**
 * The tree stage hands the projection stage its root, the anchors it bound, and
 * how many alias occurrences it saw. Anchors resolve by name at projection
 * time; the tree stage has already rejected an alias with no earlier anchor.
 */
export interface LegacyTree {
  readonly root: LegacyNode | null;
  readonly anchors: ReadonlyMap<string, LegacyNode>;
  readonly aliasCount: number;
}
