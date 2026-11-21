import { deriveAuthoringAst, getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import { Schema } from "effect";
import { normalizeJsonSchema } from "../../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "../x-extension-wire-proof.ts";

// Independently freeze the optional addition from 3c4b926b9; never import the live ServiceConfig.
// The execution-site annotation is AST-only, and normalization strips the description.
const extraArgs = Schema.optionalKey(Schema.Array(Schema.String));
const port = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }));
const model = Schema.Struct({ extraArgs, consolePort: Schema.optionalKey(port) });
const authoringModel = Schema.Struct({ extraArgs, consolePort: Schema.optionalKey(Schema.Number) });

export const extraArgsDeltas = (["bare", "authoring", "fragment"] as const).map((mode) => {
  const projected =
    mode === "bare"
      ? model
      : Schema.make<Schema.Codec<unknown>>(
          deriveAuthoringAst(authoringModel.ast, {
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
  const fields = wireObject(schema.properties);
  return { mode, field: wireObject(fields.extraArgs), witness: wireObject(fields.consolePort) };
});
