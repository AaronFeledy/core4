import { Schema } from "effect";

// ==== Effective service feature validation claims
export const ServiceFeatureValidationResult = Schema.Struct({
  handledServiceFields: Schema.Array(Schema.Literals(["webroot", "consolePort"])).annotate({
    description: "Effective service fields this feature validates and actually represents in its intent.",
  }),
}).annotate({
  identifier: "ServiceFeatureValidationResult",
  description: "Successful effective feature validation claims; findings use ServiceFeatureError only.",
  examples: [{ handledServiceFields: [] }, { handledServiceFields: ["webroot"] }],
});
export type ServiceFeatureValidationResult = typeof ServiceFeatureValidationResult.Type;
