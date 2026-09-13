import { RecipeOptionValue, RecipeProducer } from "@lando/sdk/schema";
import { Schema } from "effect";

/**
 * Why semantic comparison against generated authoring data is unavailable.
 *
 * Each reason keeps the report honest about what could not be proven; the
 * bounded current facts the file itself carries are reported either way.
 */
export const ExplainBlockedReason = Schema.Literal(
  "no-recipe",
  "bare-provenance",
  "invalid-provenance",
  "programmatic-landofile",
  "includes-present",
  "unknown-recipe",
  "identity-mismatch",
  "render-failed",
  "invalid-service-map",
);
export type ExplainBlockedReason = typeof ExplainBlockedReason.Type;

/** A current Landofile value site that references a recipe option. */
export const ExplainReference = Schema.Struct({
  path: Schema.String,
  expression: Schema.String,
});

/**
 * A generated site whose current value no longer carries the complete generated
 * expression. `currentValue` is the canonical JSON rendering of what the file
 * holds now, so the report stays one flat redactable string per site.
 */
export const ExplainTakenOverSite = Schema.Struct({
  path: Schema.String,
  generatedExpression: Schema.String,
  currentValue: Schema.String,
});

export const ExplainOption = Schema.Struct({
  name: Schema.String,
  value: Schema.optional(RecipeOptionValue),
  default: Schema.optional(RecipeOptionValue),
  status: Schema.optional(Schema.Literal("accepted-by-value", "chosen-by-value")),
  references: Schema.Array(ExplainReference),
  takenOver: Schema.Array(ExplainTakenOverSite),
});

export const ExplainComparison = Schema.Union(
  Schema.Struct({ status: Schema.Literal("matched"), snapshotVersion: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    reason: ExplainBlockedReason,
    detail: Schema.String,
    remediation: Schema.String,
  }),
);

export const ExplainServiceMapping = Schema.Struct({
  generated: Schema.String,
  current: Schema.String,
});

export const ExplainBounds = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("complete") }),
  Schema.Struct({
    _tag: Schema.Literal("truncated"),
    omitted: Schema.Struct({
      services: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      options: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      references: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      takenOver: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    }),
  }),
);

export const AppConfigExplainResultSchema = Schema.Struct({
  landofilePath: Schema.String,
  form: Schema.Literal("declarative", "programmatic", "bare", "absent"),
  recipe: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      version: Schema.optional(Schema.String),
      producer: Schema.optional(RecipeProducer),
    }),
  ),
  comparison: ExplainComparison,
  bounds: ExplainBounds,
  services: Schema.Array(ExplainServiceMapping),
  options: Schema.Array(ExplainOption),
});

export type AppConfigExplainResult = typeof AppConfigExplainResultSchema.Type;

const formatValue = (value: unknown): string => JSON.stringify(value) ?? "null";

/**
 * Human report for the active renderer.
 *
 * The heuristic labels are printed verbatim so the reader can see that
 * `accepted-by-value` is a value comparison and not a record of intent.
 */
export const renderAppConfigExplainResult = (result: AppConfigExplainResult): string => {
  const lines: string[] = [`Landofile: ${result.landofilePath}`];
  if (result.recipe === undefined) lines.push("Recipe: none recorded");
  else {
    const version = result.recipe.version === undefined ? "" : ` ${result.recipe.version}`;
    lines.push(`Recipe: ${result.recipe.id}${version}`);
    if (result.recipe.producer !== undefined) {
      const producer = result.recipe.producer;
      lines.push(`Producer: ${producer.sourceKind} ${producer.packageName}`);
      lines.push(`Digest: ${producer.contentDigest}`);
    }
  }

  if (result.comparison.status === "matched") {
    lines.push(`Comparison: matched against snapshot ${result.comparison.snapshotVersion}`);
  } else {
    lines.push(`Comparison: blocked (${result.comparison.reason})`);
    lines.push(`  ${result.comparison.detail}`);
    lines.push(`  ${result.comparison.remediation}`);
  }
  if (result.bounds._tag === "truncated") {
    const omitted = result.bounds.omitted;
    lines.push(
      `Report truncated: ${omitted.services} services, ${omitted.options} options, ${omitted.references} references, ${omitted.takenOver} taken-over sites omitted.`,
    );
  }

  for (const mapping of result.services) {
    lines.push(`Service: ${mapping.generated} is now ${mapping.current}`);
  }

  if (result.options.length === 0) lines.push("Options: none recorded");
  for (const option of result.options) {
    const value = option.value === undefined ? "(not recorded)" : formatValue(option.value);
    lines.push("", `${option.name}: ${value}`);
    if (option.default !== undefined) lines.push(`  default: ${formatValue(option.default)}`);
    if (option.status !== undefined) lines.push(`  status: ${option.status}`);
    if (option.references.length === 0) lines.push("  references: none");
    for (const reference of option.references) {
      lines.push(`  references: ${reference.path} = ${reference.expression}`);
    }
    for (const site of option.takenOver) {
      lines.push(`  taken over: ${site.path} was ${site.generatedExpression}, now ${site.currentValue}`);
    }
  }

  return lines.join("\n");
};
