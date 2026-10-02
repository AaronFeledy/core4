import { Schema } from "effect";

import { ExpressionNode } from "../expressions/ast.ts";
import { LandofileLayer } from "./landofile-reference.ts";
import { RecipeContentDigest, RecipeOptionValue, RecipeProducer } from "./recipe-identity.ts";

const metadata = (identifier: string, description: string) => ({
  identifier,
  title: identifier,
  description,
});

const StringOptionType = Schema.Struct({
  kind: Schema.Literal("string").annotate({ description: "String option discriminator." }),
  pattern: Schema.optionalKey(Schema.String.annotate({ description: "Anchored regular-expression source." })),
  minLength: Schema.optionalKey(Schema.Number.annotate({ description: "Minimum accepted length." })),
  maxLength: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum accepted length." })),
});

const NumberOptionType = Schema.Struct({
  kind: Schema.Literal("number").annotate({ description: "Number option discriminator." }),
  min: Schema.optionalKey(Schema.Number.annotate({ description: "Minimum accepted value." })),
  max: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum accepted value." })),
  integer: Schema.optionalKey(Schema.Boolean.annotate({ description: "Require an integer value." })),
});

const BooleanOptionType = Schema.Struct({
  kind: Schema.Literal("boolean").annotate({ description: "Boolean option discriminator." }),
});

const EnumOptionType = Schema.Struct({
  kind: Schema.Literal("enum").annotate({ description: "Enumerated option discriminator." }),
  values: Schema.NonEmptyArray(Schema.String).annotate({ description: "Closed set of accepted values." }),
});

const ScalarOptionType = Schema.Union([StringOptionType, NumberOptionType, BooleanOptionType, EnumOptionType]);

const ArrayOptionType = Schema.Struct({
  kind: Schema.Literal("array").annotate({ description: "Array option discriminator." }),
  items: ScalarOptionType.annotate({ description: "Scalar descriptor every element must satisfy." }),
  minItems: Schema.optionalKey(Schema.Number.annotate({ description: "Minimum element count." })),
  maxItems: Schema.optionalKey(Schema.Number.annotate({ description: "Maximum element count." })),
});

const OptionalOptionType = Schema.Struct({
  kind: Schema.Literal("optional").annotate({ description: "Optional-wrapper discriminator." }),
  inner: Schema.Union([ScalarOptionType, ArrayOptionType]).annotate({
    description: "Descriptor applied when the option is present.",
  }),
});

/**
 * The serializable option-descriptor subset a snapshot may declare. It is
 * deliberately closed: an option a recipe cannot express here makes that recipe
 * nonmigratable rather than licensing serialized code to describe it.
 */
export const RecipeOptionType = Schema.Union([StringOptionType, NumberOptionType, BooleanOptionType, EnumOptionType, ArrayOptionType, OptionalOptionType]).annotate(metadata("RecipeOptionType", "Serializable descriptor for one persistable recipe option."));
export type RecipeOptionType = typeof RecipeOptionType.Type;

/** Auxiliary file a recipe writes, recorded as metadata and digest only. */
export const RecipeSnapshotAsset = Schema.Struct({
  dest: Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
    description: "App-relative destination the recipe writes.",
  }),
  digest: RecipeContentDigest.annotate({ description: "SHA-256 of the asset content." }),
  mode: Schema.optionalKey(Schema.String.annotate({ description: "Recorded file mode, when the recipe sets one." })),
  template: Schema.optionalKey(Schema.Boolean.annotate({ description: "Whether the asset is rendered from a template." })),
}).annotate(metadata("RecipeSnapshotAsset", "Metadata and digest for one recipe-authored auxiliary file."));
export type RecipeSnapshotAsset = typeof RecipeSnapshotAsset.Type;

/**
 * The serialized expression tree a snapshot renders. It is wrapped in a named
 * carrier so the recursive expression grammar is referenced once and never
 * inlined into every schema that embeds a snapshot.
 */
export const RecipeSnapshotTemplate = Schema.Struct({
  expression: ExpressionNode.annotate({
    identifier: "ExpressionNode",
    title: "ExpressionNode",
    description: "Serialized expression tree whose only data scope is the merged options.",
  }),
}).annotate(metadata("RecipeSnapshotTemplate", "Carrier for one snapshot's serialized expression tree."));
export type RecipeSnapshotTemplate = typeof RecipeSnapshotTemplate.Type;

/**
 * Everything needed to re-render a recipe version's authoring output without
 * running recipe code: its exact identity, the options it accepts, their
 * defaults, one serialized expression tree, and its asset inventory.
 */
export const RecipeSnapshot = Schema.Struct({
  identity: RecipeProducer.annotate({ description: "Exact versioned producer this snapshot describes." }),
  optionTypes: Schema.Record(Schema.String, RecipeOptionType).annotate({
    description: "Serializable descriptor for every persistable option.",
  }),
  defaults: Schema.Record(Schema.String, RecipeOptionValue).annotate({
    description: "Default value for each option at this version.",
  }),
  template: RecipeSnapshotTemplate.annotate({
    description: "One serialized expression tree whose only data scope is the merged options.",
  }),
  assets: Schema.Array(RecipeSnapshotAsset).annotate({
    description: "Auxiliary files this version writes, as metadata and digests.",
  }),
}).annotate(metadata("RecipeSnapshot", "Inert declarative data that renders one recipe version's authoring output."));
export type RecipeSnapshot = typeof RecipeSnapshot.Type;

/** The declarative operations a migration edge may declare. */
export const RecipeHunkKind = Schema.Literals(["option-default", "add", "remove", "rename", "replace"]).annotate(metadata("RecipeHunkKind", "Declarative migration operation kind."));
export type RecipeHunkKind = typeof RecipeHunkKind.Type;

/** How analysis resolved one hunk against the current file. */
export const RecipeHunkClassification = Schema.Literals(["already-satisfied", "selected", "retained-option", "blocking"]).annotate(metadata("RecipeHunkClassification", "Resolution class assigned to one migration hunk."));
export type RecipeHunkClassification = typeof RecipeHunkClassification.Type;

const HUNK_ID_PATTERN = /^hunk-[0-9a-f]{24}$/;

const hunkIdField = Schema.String.pipe(Schema.check(Schema.isPattern(HUNK_ID_PATTERN))).annotate({
  description: "Stable id derived from producer family, edge endpoints, layer, kind, and canonical path.",
});

const hunkLayerField = LandofileLayer.annotate({
  description: "Layer that owns the target path; a lower layer never edits a higher-layer value.",
});

const hunkPathField = Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
  description: "Canonical dotted path this hunk targets.",
});

const OptionDefaultHunk = Schema.Struct({
  id: hunkIdField,
  kind: Schema.Literal("option-default").annotate({ description: "Option-default change discriminator." }),
  layer: hunkLayerField,
  path: hunkPathField,
  old: RecipeOptionValue.annotate({ description: "Default this version replaced." }),
  new: RecipeOptionValue.annotate({ description: "Default this version introduces." }),
});

const AddHunk = Schema.Struct({
  id: hunkIdField,
  kind: Schema.Literal("add").annotate({ description: "Structural add discriminator." }),
  layer: hunkLayerField,
  path: hunkPathField,
  new: Schema.Unknown.annotate({ description: "Authoring value the target must hold after the edge." }),
});

const RemoveHunk = Schema.Struct({
  id: hunkIdField,
  kind: Schema.Literal("remove").annotate({ description: "Structural remove discriminator." }),
  layer: hunkLayerField,
  path: hunkPathField,
  old: Schema.Unknown.annotate({ description: "Authoring value the target must hold before the edge." }),
});

const RenameHunk = Schema.Struct({
  id: hunkIdField,
  kind: Schema.Literal("rename").annotate({ description: "Structural rename discriminator." }),
  layer: hunkLayerField,
  path: hunkPathField,
  old: Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
    description: "Canonical path before the rename.",
  }),
  new: Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
    description: "Canonical path after the rename.",
  }),
});

const ReplaceHunk = Schema.Struct({
  id: hunkIdField,
  kind: Schema.Literal("replace").annotate({ description: "Structural replace discriminator." }),
  layer: hunkLayerField,
  path: hunkPathField,
  old: Schema.Unknown.annotate({ description: "Authoring value the target must hold before the edge." }),
  new: Schema.Unknown.annotate({ description: "Authoring value the target must hold after the edge." }),
});

/**
 * One declared edit inside a migration edge. Every hunk names its owning layer
 * and carries enough before/after context to render a deterministic diff and
 * decide whether the target is still untouched.
 */
export const RecipeMigrationHunk = Schema.Union([OptionDefaultHunk, AddHunk, RemoveHunk, RenameHunk, ReplaceHunk]).annotate(metadata("RecipeMigrationHunk", "One declarative edit inside a recipe migration edge."));
export type RecipeMigrationHunk = typeof RecipeMigrationHunk.Type;

/**
 * One edge between two exact versioned producer identities. Both endpoints ship
 * a full snapshot so the renderer derives the old and new authoring output from
 * the user's current options instead of trusting a single frozen fragment.
 */
export const RecipeMigration = Schema.Struct({
  from: RecipeProducer.annotate({ description: "Exact versioned identity this edge migrates away from." }),
  to: RecipeProducer.annotate({ description: "Exact versioned identity this edge migrates to." }),
  fromSnapshot: RecipeSnapshot.annotate({
    description: "Renderable snapshot for the edge source version.",
  }),
  toSnapshot: RecipeSnapshot.annotate({ description: "Renderable snapshot for the edge target version." }),
  hunks: Schema.Array(RecipeMigrationHunk).annotate({
    description: "Ordered declared edits, validated against the rendered snapshot diff.",
  }),
}).annotate(metadata("RecipeMigration", "One declarative migration edge between two recipe versions."));
export type RecipeMigration = typeof RecipeMigration.Type;

/**
 * True when serialized migration data carries a callable value. Manifests
 * describe edits as data; a function smuggled through a runtime object is
 * rejected before any snapshot renders.
 */
export const hasCallableApply = (raw: unknown): boolean => {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (typeof value === "function") return true;
    if (value === null || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some(visit);
  };
  return visit(raw);
};
