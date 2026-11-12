import { deriveAuthoringAst, getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import { Schema } from "effect";
import { normalizeJsonSchema } from "../../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "../x-extension-wire-proof.ts";
import { historicalEnvironment, historicalEnvironmentValue } from "./x-extension-environment.delta.ts";

// Independently freeze the tooling vars change; never import the live tooling schemas.
// Tasks drop the `{ default }` and `{ prompt }` forms and give `{ sh }` an optional per-var
// target, environment, and sensitivity marker; `toolingDefaults.vars` keeps only literals.
// The per-var `env` reuses the frozen environment model from the environment delta (the
// same BoundText/SecretRef value union and reserved-key map), never the live primitives.
const literal = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
const vars = (value: Schema.Top) =>
  Schema.Struct({ vars: Schema.optionalKey(Schema.Record(Schema.String, value)) });
const models = {
  before: vars(
    Schema.Union([
      literal,
      Schema.Struct({ default: literal }),
      Schema.Struct({ sh: Schema.String }),
      Schema.Struct({ prompt: Schema.String }),
    ]),
  ),
  task: vars(
    Schema.Union([
      literal,
      Schema.Struct({
        sh: Schema.String,
        service: Schema.optionalKey(Schema.String),
        env: Schema.optionalKey(historicalEnvironment(historicalEnvironmentValue)),
        sensitive: Schema.optionalKey(Schema.Literal(true)),
      }),
    ]),
  ),
  defaults: vars(literal),
};

// Frozen copy of the composite authoring text grammar a string site accepts. The
// environment delta's value union nests string discriminators whose literal branch only
// survives beside this composite slot, so model it instead of a plain string slot.
const COMPOSITE_EXPRESSION_PATTERN =
  "^(?:\\{\\{\\{\\{|\\$\\$\\{|\\{\\{#(?:(?!#\\}\\})[\\s\\S])*#\\}\\}|(?!\\{\\{|\\$\\$\\{|\\$\\{|\\$[A-Za-z_])[\\s\\S])*(?:\\{\\{(?!#)(?:(?!\\{\\{|\\}\\})[\\s\\S])+\\}\\}|\\$(?:[A-Za-z_][A-Za-z0-9_]*|\\{(?:secret:[^}]+|[A-Za-z_][A-Za-z0-9_]*(?:(?::-|-|:\\?|:\\+)[^}]*)?)\\}))";
const wholeExpressionPattern = /^\{\{(?!#)-?(?:(?!\{\{|\}\})[\s\S])+?-?\}\}(?![\s\S])/u;
const slotFor = (kind: "string" | "number" | "boolean" | "array" | "object" | "unknown") => {
  if (kind === "string")
    return Schema.String.check(
      Schema.makeFilter(() => true, {
        "~structural": true,
        toJsonSchema: () => ({ pattern: COMPOSITE_EXPRESSION_PATTERN }),
      }),
    ).ast;
  return kind === "unknown"
    ? Schema.String.annotate({}).ast
    : Schema.String.check(Schema.isPattern(wholeExpressionPattern)).ast;
};

const project = (model: Schema.Top, mode: "bare" | "authoring" | "fragment") => {
  const projected =
    mode === "bare"
      ? model
      : Schema.make<Schema.Codec<unknown>>(
          deriveAuthoringAst(model.ast, {
            partial: mode === "fragment",
            directives: mode === "fragment",
            slotFor,
            rootExpression: false,
          }),
        );
  const schema = normalizeJsonSchema(
    wireObject(getJsonSchemaWithDeprecations(projected, { onExcessProperty: "error" })),
  );
  return wireObject(wireObject(schema.properties).vars);
};

export const toolingVarsDeltas = (["bare", "authoring", "fragment"] as const).map((mode) => ({
  mode,
  before: project(models.before, mode),
  task: project(models.task, mode),
  defaults: project(models.defaults, mode),
}));
