/**
 * Shared types for the Lando 3 frontend.
 *
 * Every stage here reads one bounded document set that core already read from
 * disk. Nothing in this package opens a file, follows a reference, or resolves
 * a tag: `!load` and `!import` stay tagged data so a later lowering stage can
 * rewrite them into authoring expressions.
 */
import type { LegacySourceSpan } from "@lando/sdk/landofile";
import type { ConfigTranslateSourceId, LandofileLayer } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";

/**
 * Lando 3 loads one more layer than Lando 4 does. `recipe` sits between `dist`
 * and `upstream`; it has no v4 counterpart and folds into `dist` on output.
 */
export const LANDO3_SOURCE_LAYERS = [
  "base",
  "dist",
  "recipe",
  "upstream",
  "canonical",
  "local",
  "user",
] as const;

export type Lando3SourceLayer = (typeof LANDO3_SOURCE_LAYERS)[number];

/** Lando 3 basenames in load order, later winning. */
export const LANDO3_LAYER_BASENAMES: ReadonlyArray<readonly [Lando3SourceLayer, string]> = [
  ["base", ".lando.base"],
  ["dist", ".lando.dist"],
  ["recipe", ".lando.recipe"],
  ["upstream", ".lando.upstream"],
  ["canonical", ".lando"],
  ["local", ".lando.local"],
  ["user", ".lando.user"],
];

export const lando3SourceLayerOrder = (layer: Lando3SourceLayer): number =>
  LANDO3_SOURCE_LAYERS.indexOf(layer);

/** `.lando.recipe.yml` folds into dist; every other layer keeps its name. */
export const lando3TargetLayer = (layer: Lando3SourceLayer): LandofileLayer =>
  layer === "recipe" ? "dist" : layer;

/** A path into a decoded Lando 3 document: mapping keys and array indexes. */
export type Lando3Path = ReadonlyArray<string | number>;

/** Where one contribution to a merged value came from. */
export interface LegacyOccurrence {
  readonly sourceId: ConfigTranslateSourceId;
  readonly layer: Lando3SourceLayer;
  readonly keyPath: Lando3Path;
  readonly span: LegacySourceSpan | undefined;
}

/**
 * Legacy array equality. Lando 3 deduplicates a concatenated array with
 * lodash `uniq`, which is SameValueZero: primitives compare by value and
 * everything else compares by identity. Within one document two items written
 * as the same anchor or alias ARE one object, so they carry the same
 * `anchor` token; every other collection is its own identity.
 */
export type LegacyItemIdentity =
  | { readonly kind: "primitive"; readonly value: string | number | boolean | null }
  | { readonly kind: "anchor"; readonly sourceId: ConfigTranslateSourceId; readonly name: string }
  | { readonly kind: "unique"; readonly token: symbol };

export type MergedLegacyValue =
  | {
      readonly kind: "scalar";
      readonly value: string | number | boolean | null;
      readonly winner: LegacyOccurrence;
      readonly history: ReadonlyArray<LegacyOccurrence>;
    }
  | {
      readonly kind: "tagged";
      readonly tag: string;
      readonly value: MergedLegacyValue;
      readonly winner: LegacyOccurrence;
      readonly history: ReadonlyArray<LegacyOccurrence>;
    }
  | {
      readonly kind: "mapping";
      readonly entries: ReadonlyMap<string, MergedLegacyValue>;
      readonly occurrences: ReadonlyArray<LegacyOccurrence>;
    }
  | {
      readonly kind: "sequence";
      readonly items: ReadonlyArray<MergedLegacyItem>;
      readonly occurrences: ReadonlyArray<LegacyOccurrence>;
    };

export interface MergedLegacyItem {
  readonly value: MergedLegacyValue;
  readonly identity: LegacyItemIdentity;
  readonly occurrences: ReadonlyArray<LegacyOccurrence>;
}

/** One parsed Lando 3 source document, ready to merge. */
export interface Lando3Source {
  readonly sourceId: ConfigTranslateSourceId;
  readonly layer: Lando3SourceLayer;
  readonly file: string;
  readonly value: MergedLegacyValue | undefined;
}

/**
 * Ports a host supplies when it builds the translator. Recipe decomposition is
 * injected rather than reimplemented, so this package never imports core and
 * never grows a second recipe expansion.
 */
export interface Lando3TranslatorPorts {
  readonly decomposers: ReadonlyMap<string, RecipeDecomposerFactory>;
  readonly redactor: Redactor;
}

/** The translator id this package contributes. */
export const LANDO3_TRANSLATOR_ID = "lando3";
