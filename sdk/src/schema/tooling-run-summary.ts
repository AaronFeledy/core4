import { Schema } from "effect";

// ==== Bounded execution metadata for tooling help
export const ToolingRunTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("service").annotate({ description: "A fixed service target." }),
    name: Schema.String.annotate({ description: "Service name." }),
  }),
  Schema.Struct({ kind: Schema.Literal("host").annotate({ description: "The host machine." }) }),
  Schema.Struct({
    kind: Schema.Literal("flag").annotate({ description: "A service selected by an input flag." }),
    flag: Schema.String.annotate({ description: "Name of the service-selection flag." }),
  }),
  Schema.Struct({ kind: Schema.Literal("primary").annotate({ description: "The app's primary service." }) }),
  Schema.Struct({ kind: Schema.Literal("dynamic").annotate({ description: "An invocation-time target." }) }),
]).annotate({ identifier: "ToolingRunTarget", description: "A tooling command's execution target." });
export type ToolingRunTarget = typeof ToolingRunTarget.Type;

export const ToolingRunSummary = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("commands").annotate({ description: "A Landofile tooling task." }),
    steps: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(1000),
    ).annotate({ description: "Number of command steps." }),
    targets: Schema.Array(ToolingRunTarget)
      .check(Schema.isMinLength(1), Schema.isMaxLength(32), Schema.isUnique())
      .annotate({ description: "Distinct execution targets in authored order." }),
    program: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))).annotate({
      description: "Conservatively extracted program token for a single command.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("script").annotate({ description: "A Bun Shell script task." }),
    path: Schema.String.check(Schema.isMaxLength(512)).annotate({
      description: "Script path relative to the app root, including .lando/scripts/.",
    }),
  }),
]).annotate({
  identifier: "ToolingRunSummary",
  description: "Bounded execution summary for CLI tooling help.",
});
export type ToolingRunSummary = typeof ToolingRunSummary.Type;
