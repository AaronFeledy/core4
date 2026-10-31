import {
  authoringExpressionSlot,
  deriveAuthoringAst,
  getJsonSchemaWithDeprecations,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import { normalizeJsonSchema } from "../../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "../x-extension-wire-proof.ts";

// Independently modeled addition from 991e7fc11ce31f6910a03e47494965b14d48c6d3.
// Do not import the live ServiceConfig or PortNumber contract into this proof.
const port = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
);
const model = Schema.Struct({ consolePort: Schema.optionalKey(port) });
const authoringModel = Schema.Struct({ consolePort: Schema.optionalKey(Schema.Number) });

export const consolePortDeltas = (["bare", "authoring", "fragment"] as const).map((mode) => {
  const projected =
    mode === "bare"
      ? model
      : Schema.make<Schema.Codec<unknown>>(
          deriveAuthoringAst(authoringModel.ast, {
            partial: mode === "fragment",
            directives: mode === "fragment",
            slotFor: (kind) => authoringExpressionSlot(kind).ast,
            rootExpression: false,
          }),
        );
  const schema = normalizeJsonSchema(
    wireObject(getJsonSchemaWithDeprecations(projected, { onExcessProperty: "error" })),
  );
  return { mode, field: wireObject(wireObject(schema.properties).consolePort) };
});
