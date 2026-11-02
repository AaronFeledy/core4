import { deriveAuthoringAst, getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import { Schema } from "effect";
import { normalizeJsonSchema } from "../../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "../x-extension-wire-proof.ts";

// Independently freeze the optional addition from 05972952d; never import the live ServiceConfig.
const path = Schema.String.check(
  Schema.isPattern(
    /^(?!\/)(?!\*$)(?!.*\/\/)(?!.*\.\.)(?!.*\*\*)(?!.*\/$)(?!(?:^|.*\/)\.(?:\/|$))[A-Za-z0-9._/*-]+$/u,
  ),
);
const port = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }));
const model = Schema.Struct({
  noScripts: Schema.optionalKey(Schema.Array(path)),
  consolePort: Schema.optionalKey(port),
});
const authoringModel = Schema.Struct({
  noScripts: Schema.optionalKey(Schema.Array(Schema.String)),
  consolePort: Schema.optionalKey(Schema.Number),
});

export const noScriptsDeltas = (["bare", "authoring", "fragment"] as const).map((mode) => {
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
  return {
    mode,
    field: wireObject(wireObject(schema.properties).noScripts),
    witness: wireObject(wireObject(schema.properties).consolePort),
  };
});
