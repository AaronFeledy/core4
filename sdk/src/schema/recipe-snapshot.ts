import { Schema } from "effect";

import { ExpressionNode } from "../expressions/ast.ts";
import { LandofileLayer } from "./landofile-reference.ts";
import { RecipeContentDigest, RecipeOptionValue, RecipeProducer } from "./recipe-identity.ts";

// ==== Declarative recipe snapshots and migration edges — inert data, never code.

const metadata = (identifier: string, description: string) => ({
  identifier,
  title: identifier,
  description,
});

const StringOptionType = Schema.Struct({
  kind: Schema.Literal("string").annotations({ description: "String option discriminator." }),
  pattern: Schema.optional(Schema.String.annotations({ description: "Anchored regular-expression source." })),
  minLength: Schema.optional(Schema.Number.annotations({ description: "Minimum accepted length." })),
  maxLength: Schema.optional(Schema.Number.annotations({ description: "Maximum accepted length." })),
});

const NumberOptionType = Schema.Struct({
  kind: Schema.Literal("number").annotations({ description: "Number option discriminator." }),
  min: Schema.optional(Schema.Number.annotations({ description: "Minimum accepted value." })),
  max: Schema.optional(Schema.Number.annotations({ description: "Maximum accepted value." })),
  integer: Schema.optional(Schema.Boolean.annotations({ description: "Require an integer value." })),
});

const BooleanOptionType = Schema.Struct({
  kind: Schema.Literal("boolean").annotations({ description: "Boolean option discriminator." }),
});

const EnumOptionType = Schema.Struct({
  kind: Schema.Literal("enum").annotations({ description: "Enumerated option discriminator." }),
  values: Schema.NonEmptyArray(Schema.String).annotations({ description: "Closed set of accepted values." }),
});

const ScalarOptionType = Schema.Union(StringOptionType, NumberOptionType, BooleanOptionType, EnumOptionType);

const ArrayOptionType = Schema.Struct({
  kind: Schema.Literal("array").annotations({ description: "Array option discriminator." }),
  items: ScalarOptionType.annotations({ description: "Scalar descriptor every element must satisfy." }),
  minItems: Schema.optional(Schema.Number.annotations({ description: "Minimum element count." })),
  maxItems: Schema.optional(Schema.Number.annotations({ description: "Maximum element count." })),
});

const OptionalOptionType = Schema.Struct({
  kind: Schema.Literal("optional").annotations({ description: "Optional-wrapper discriminator." }),
  inner: Schema.Union(ScalarOptionType, ArrayOptionType).annotations({
    description: "Descriptor applied when the option is present.",
  }),
});

/**
 * The serializable option-descriptor subset a snapshot may declare. It is
 * deliberately closed: an option a recipe cannot express here makes that recipe
 * nonmigratable rather than licensing serialized code to describe it.
 */
export const RecipeOptionType = Schema.Union(
  StringOptionType,
  NumberOptionType,
  BooleanOptionType,
  EnumOptionType,
  ArrayOptionType,
  OptionalOptionType,
).annotations(metadata("RecipeOptionType", "Serializable descriptor for one persistable recipe option."));
export type RecipeOptionType = typeof RecipeOptionType.Type;

/** Auxiliary file a recipe writes, recorded as metadata and digest only. */
export const RecipeSnapshotAsset = Schema.Struct({
  dest: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: "App-relative destination the recipe writes.",
  }),
  digest: RecipeContentDigest.annotations({ description: "SHA-256 of the asset content." }),
  mode: Schema.optional(
    Schema.String.annotations({ description: "Recorded file mode, when the recipe sets one." }),
  ),
  template: Schema.optional(
    Schema.Boolean.annotations({ description: "Whether the asset is rendered from a template." }),
  ),
}).annotations(
  metadata("RecipeSnapshotAsset", "Metadata and digest for one recipe-authored auxiliary file."),
);
export type RecipeSnapshotAsset = typeof RecipeSnapshotAsset.Type;

/**
 * The serialized expression tree a snapshot renders. It is wrapped in a named
 * carrier so the recursive expression grammar is referenced once and never
 * inlined into every schema that embeds a snapshot.
 */
export const RecipeSnapshotTemplate = Schema.Struct({
  expression: ExpressionNode.annotations({
    identifier: "ExpressionNode",
    title: "ExpressionNode",
    description: "Serialized expression tree whose only data scope is the merged options.",
  }),
}).annotations(metadata("RecipeSnapshotTemplate", "Carrier for one snapshot's serialized expression tree."));
export type RecipeSnapshotTemplate = typeof RecipeSnapshotTemplate.Type;

/**
 * Everything needed to re-render a recipe version's authoring output without
 * running recipe code: its exact identity, the options it accepts, their
 * defaults, one serialized expression tree, and its asset inventory.
 */
export const RecipeSnapshot = Schema.Struct({
  identity: RecipeProducer.annotations({ description: "Exact versioned producer this snapshot describes." }),
  optionTypes: Schema.Record({ key: Schema.String, value: RecipeOptionType }).annotations({
    description: "Serializable descriptor for every persistable option.",
  }),
  defaults: Schema.Record({ key: Schema.String, value: RecipeOptionValue }).annotations({
    description: "Default value for each option at this version.",
  }),
  template: RecipeSnapshotTemplate.annotations({
    description: "One serialized expression tree whose only data scope is the merged options.",
  }),
  assets: Schema.Array(RecipeSnapshotAsset).annotations({
    description: "Auxiliary files this version writes, as metadata and digests.",
  }),
}).annotations(
  metadata("RecipeSnapshot", "Inert declarative data that renders one recipe version's authoring output."),
);
export type RecipeSnapshot = typeof RecipeSnapshot.Type;

/** The declarative operations a migration edge may declare. */
export const RecipeHunkKind = Schema.Literal(
  "option-default",
  "add",
  "remove",
  "rename",
  "replace",
).annotations(metadata("RecipeHunkKind", "Declarative migration operation kind."));
export type RecipeHunkKind = typeof RecipeHunkKind.Type;

/** How analysis resolved one hunk against the current file. */
export const RecipeHunkClassification = Schema.Literal(
  "already-satisfied",
  "selected",
  "retained-option",
  "blocking",
).annotations(metadata("RecipeHunkClassification", "Resolution class assigned to one migration hunk."));
export type RecipeHunkClassification = typeof RecipeHunkClassification.Type;

const HUNK_ID_PATTERN = /^hunk-[0-9a-f]{24}$/;

const hunkIdField = Schema.String.pipe(Schema.pattern(HUNK_ID_PATTERN)).annotations({
  description: "Stable id derived from producer family, edge endpoints, layer, kind, and canonical path.",
});

const hunkLayerField = LandofileLayer.annotations({
  description: "Layer that owns the target path; a lower layer never edits a higher-layer value.",
});

const hunkPathField = Schema.String.pipe(Schema.minLength(1)).annotations({
  description: "Canonical dotted path this hunk targets.",
});

const OptionDefaultHunk = Schema.Struct({
  id: hunkIdField,
  kind: Schema.Literal("option-default").annotations({ description: "Option-default change discriminator." }),
  layer: hunkLayerField,
  path: hunkPathField,
  old: RecipeOptionValue.annotations({ description: "Default this version replaced." }),
  new: RecipeOptionValue.annotations({ description: "Default this version introduces." }),
});

const AddHunk = Schema.Struct({
  id: hunkIdField,
  kind: Schema.Literal("add").annotations({ description: "Structural add discriminator." }),
  layer: hunkLayerField,
  path: hunkPathField,
  new: Schema.Unknown.annotations({ description: "Authoring value the target must hold after the edge." }),
});

const RemoveHunk = Schema.Struct({
  id: hunkIdField,
  kind: Schema.Literal("remove").annotations({ description: "Structural remove discriminator." }),
  layer: hunkLayerField,
  path: hunkPathField,
  old: Schema.Unknown.annotations({ description: "Authoring value the target must hold before the edge." }),
});

const RenameHunk = Schema.Struct({
  id: hunkIdField,
  kind: Schema.Literal("rename").annotations({ description: "Structural rename discriminator." }),
  layer: hunkLayerField,
  path: hunkPathField,
  old: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: "Canonical path before the rename.",
  }),
  new: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: "Canonical path after the rename.",
  }),
});

const ReplaceHunk = Schema.Struct({
  id: hunkIdField,
  kind: Schema.Literal("replace").annotations({ description: "Structural replace discriminator." }),
  layer: hunkLayerField,
  path: hunkPathField,
  old: Schema.Unknown.annotations({ description: "Authoring value the target must hold before the edge." }),
  new: Schema.Unknown.annotations({ description: "Authoring value the target must hold after the edge." }),
});

/**
 * One declared edit inside a migration edge. Every hunk names its owning layer
 * and carries enough before/after context to render a deterministic diff and
 * decide whether the target is still untouched.
 */
export const RecipeMigrationHunk = Schema.Union(
  OptionDefaultHunk,
  AddHunk,
  RemoveHunk,
  RenameHunk,
  ReplaceHunk,
).annotations(metadata("RecipeMigrationHunk", "One declarative edit inside a recipe migration edge."));
export type RecipeMigrationHunk = typeof RecipeMigrationHunk.Type;

/**
 * One edge between two exact versioned producer identities. Both endpoints ship
 * a full snapshot so the renderer derives the old and new authoring output from
 * the user's current options instead of trusting a single frozen fragment.
 */
export const RecipeMigration = Schema.Struct({
  from: RecipeProducer.annotations({ description: "Exact versioned identity this edge migrates away from." }),
  to: RecipeProducer.annotations({ description: "Exact versioned identity this edge migrates to." }),
  fromSnapshot: RecipeSnapshot.annotations({
    description: "Renderable snapshot for the edge source version.",
  }),
  toSnapshot: RecipeSnapshot.annotations({ description: "Renderable snapshot for the edge target version." }),
  hunks: Schema.Array(RecipeMigrationHunk).annotations({
    description: "Ordered declared edits, validated against the rendered snapshot diff.",
  }),
}).annotations(metadata("RecipeMigration", "One declarative migration edge between two recipe versions."));
export type RecipeMigration = typeof RecipeMigration.Type;

/**
 * True when a serialized migration edge carries a callable `apply`. Serialized
 * manifests describe edits as data; a function smuggled through a runtime object
 * literal is rejected before any snapshot renders.
 */
export const hasCallableApply = (raw: unknown): boolean => {
  if (raw === null || typeof raw !== "object") return false;
  const candidate = (raw as { readonly apply?: unknown }).apply;
  return typeof candidate === "function";
};
