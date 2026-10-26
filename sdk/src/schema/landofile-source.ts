import { Schema } from "effect";
import { LandofileLayer } from "./landofile-reference.ts";

// ==== Authored inspection transport
export const LandofileSourceValue = Schema.Json.annotate({
  identifier: "LandofileSourceValue",
  description:
    "Recursive JSON source data with finite numbers and directive envelopes; literal envelope-shaped maps are escaped.",
});
export type LandofileSourceValue = typeof LandofileSourceValue.Type;

export const LandofileSourceDocument = Schema.Struct({
  layer: LandofileLayer.annotate({ description: "Authored layer identity in low-to-high precedence order." }),
  file: Schema.String.annotate({ description: "Absolute source file path." }),
  form: Schema.Literals(["yaml", "typescript"]).annotate({ description: "Source language." }),
  document: LandofileSourceValue,
});
export type LandofileSourceDocument = typeof LandofileSourceDocument.Type;

export const LandofileSourceProjection = Schema.Struct({
  ...LandofileSourceDocument.fields,
  document: Schema.optionalKey(LandofileSourceValue),
});
export type LandofileSourceProjection = typeof LandofileSourceProjection.Type;
