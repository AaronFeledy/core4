import { deriveAuthoringAst, getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import { Schema } from "effect";
import { normalizeJsonSchema } from "../../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "../x-extension-wire-proof.ts";

// Independently freeze the optional addition from c50f18c19; never import the live ServiceConfig.
// Normalization strips field descriptions, so the independently modeled field is the constraint only.
const packageCache = Schema.optionalKey(Schema.Literal(false));
const extraArgs = Schema.optionalKey(Schema.Array(Schema.String));
const model = Schema.Struct({ packageCache, extraArgs });
const authoringModel = Schema.Struct({ packageCache, extraArgs });

export const packageCacheDeltas = (["bare", "authoring", "fragment"] as const).map((mode) => {
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
  return { mode, field: wireObject(fields.packageCache), witness: wireObject(fields.extraArgs) };
});
