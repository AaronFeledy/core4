import { deriveAuthoringAst, getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import { Schema } from "effect";
import { normalizeJsonSchema } from "../../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "../x-extension-wire-proof.ts";

// Independently freeze the tooling vars change; never import the live tooling schemas.
// Tasks drop the `{ default }` and `{ prompt }` forms and give `{ sh }` an optional per-var
// target and sensitivity marker; `toolingDefaults.vars` keeps only literals.
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
        sensitive: Schema.optionalKey(Schema.Literal(true)),
      }),
    ]),
  ),
  defaults: vars(literal),
};

const project = (model: Schema.Top, mode: "bare" | "authoring" | "fragment") => {
  const projected =
    mode === "bare"
      ? model
      : Schema.make<Schema.Codec<unknown>>(
          deriveAuthoringAst(model.ast, {
            partial: mode === "fragment",
            directives: mode === "fragment",
            slotFor: (kind) =>
              kind === "string" || kind === "unknown"
                ? Schema.String.annotate({}).ast
                : Schema.String.check(
                    Schema.isPattern(/^\{\{(?!#)-?(?:(?!\{\{|\}\})[\s\S])+?-?\}\}(?![\s\S])/u),
                  ).ast,
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
