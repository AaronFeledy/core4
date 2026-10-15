import { Schema, type SchemaAST } from "effect";

// ============================================================================
// Collection layer policy, attached before optionalKey and on both codec views.
// ============================================================================

/** Namespaced annotation selecting a collection's Landofile layer policy. */
export const SchemaLayerMergeAnnotationId = "lando/schema/LayerMerge" as const;

export const LayerMergeRule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("replace").annotate({ description: "Replace the inherited collection wholesale." }),
  }),
  Schema.Struct({
    kind: Schema.Literal("keyed").annotate({ description: "Merge the collection by its declared identity." }),
    identity: Schema.Literals([
      "route-match",
      "dependency-service",
      "log-id",
      "endpoint-name",
      "port-name",
      "filter-name-or-type",
    ]).annotate({ description: "Named authored-value projection and atomic key implementation." }),
    whenUnkeyed: Schema.Literal("replace").annotate({
      description: "Replace when either collection has an unkeyed entry.",
    }),
    onMatch: Schema.Literals(["merge", "replace-on-type-change"]).annotate({
      description: "How a matched entry overlays its inherited value.",
    }),
  }),
]).annotate({
  identifier: "LayerMergeRule",
  title: "Layer Merge Rule",
  description: "Declared collection policy for Landofile layers.",
});
export type LayerMergeRule = typeof LayerMergeRule.Type;

/** Attach a serializable policy to a collection schema, preserving its type. */
export const layerMerge = <S extends Schema.Top>(schema: S, rule: LayerMergeRule) =>
  schema.annotate({ [SchemaLayerMergeAnnotationId]: rule });

/** Read the policy on this AST node without discarding a codec's decoded view. */
export const getLayerMergeRule = (ast: SchemaAST.AST): LayerMergeRule | undefined => {
  const value =
    ast.annotations?.[SchemaLayerMergeAnnotationId] ??
    ast.context?.annotations?.[SchemaLayerMergeAnnotationId];
  return Schema.is(LayerMergeRule)(value) ? value : undefined;
};
