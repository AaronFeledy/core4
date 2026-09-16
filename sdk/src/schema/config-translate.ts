import { Schema } from "effect";
import { LandofileAuthoringFragmentWire, LandofileAuthoringShapeWire } from "./landofile-authoring.ts";
import { LandofileLayer } from "./landofile-reference.ts";
import { PortablePath } from "./primitives.ts";

// ==== Source snapshots and translation requests
const metadata = (identifier: string, description: string) => ({
  identifier,
  title: identifier,
  description,
});
interface AuthoringFragmentSchema
  extends Schema.Schema<Schema.Schema.Type<typeof LandofileAuthoringFragmentWire>> {}
interface AuthoringContextSchema
  extends Schema.Schema<Schema.Schema.Type<typeof LandofileAuthoringShapeWire>> {}
const authoringFragment = (description: string): AuthoringFragmentSchema =>
  LandofileAuthoringFragmentWire.annotations({ description });
const authoringContext: AuthoringContextSchema = LandofileAuthoringShapeWire.annotations({
  description: "Complete validated authoring wire context.",
});
export const ConfigTranslateSourceId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ConfigTranslateSourceId"),
).annotations(
  metadata("ConfigTranslateSourceId", "Core-assigned document or synthetic recipe source identity."),
);
export const ConfigTranslateConfidence = Schema.Literal("exact", "likely", "possible").annotations(
  metadata("ConfigTranslateConfidence", "Translator detection confidence."),
);
export const ConfigTranslateMode = Schema.Literal("full", "single-layer").annotations(
  metadata("ConfigTranslateMode", "Full document-set or selected-layer conversion."),
);
export const ConfigTranslateDocumentBytes = Schema.Uint8ArrayFromBase64.annotations({
  description: "Bounded raw source bytes, encoded as base64 on the wire.",
});
export const ConfigTranslateDocument = Schema.Struct({
  sourceId: ConfigTranslateSourceId.annotations({ description: "Stable identity assigned to this source." }),
  layerId: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: "Foreign source layer identity.",
  }),
  path: Schema.optional(PortablePath.annotations({ description: "App-relative source path." })),
  mediaType: Schema.String.annotations({ description: "Source media type." }),
  contentDigest: Schema.String.pipe(Schema.pattern(/^sha256:[0-9a-f]{64}$/)).annotations({
    description: "SHA-256 digest of the raw source bytes.",
  }),
  bytes: ConfigTranslateDocumentBytes,
}).annotations(metadata("ConfigTranslateDocument", "Core-read immutable source snapshot."));
export const ConfigTranslateLayerFragment = Schema.Struct({
  layerId: LandofileLayer.annotations({ description: "Existing lower v4 layer." }),
  fragment: authoringFragment("Lower-layer authoring wire fragment."),
}).annotations(metadata("ConfigTranslateLayerFragment", "Authoring context for a lower layer."));
export const ConfigTranslateDocumentSetInput = Schema.Struct({
  _tag: Schema.Literal("landofile-document-set").annotations({
    description: "Document-set request discriminator.",
  }),
  documents: Schema.Array(ConfigTranslateDocument).annotations({
    description: "Source snapshots in canonical document order.",
  }),
  mode: ConfigTranslateMode.annotations({ description: "Requested conversion scope." }),
  selectedSourceIds: Schema.Array(ConfigTranslateSourceId).annotations({
    description: "Selected sources; nonempty for single-layer conversion.",
  }),
  currentLowerV4Fragments: Schema.Array(ConfigTranslateLayerFragment).annotations({
    description: "Already validated lower-layer context.",
  }),
  writableLayerIds: Schema.Array(LandofileLayer).annotations({
    description: "Nonempty output-layer allowlist.",
  }),
}).annotations(metadata("ConfigTranslateDocumentSetInput", "One ordered document set to translate."));
const AnswerScalar = Schema.Union(Schema.String, Schema.Number, Schema.Boolean);
export const ConfigTranslateAnswerValue = Schema.Union(AnswerScalar, Schema.Array(AnswerScalar)).annotations(
  metadata("ConfigTranslateAnswerValue", "Nonsecret scalar or scalar-array recipe answer."),
);
export const ConfigTranslateSecretReference = Schema.Union(
  Schema.Struct({
    disposition: Schema.Literal("secret-store").annotations({ description: "Stored-secret disposition." }),
    reference: Schema.String.pipe(Schema.pattern(/^\$\{secret:[^}]+\}$/)).annotations({
      description: "One canonical ${secret:...} reference, never the secret value.",
    }),
  }).annotations(metadata("ConfigTranslateStoredSecretReference", "Approved stored-secret reference.")),
  Schema.Struct({
    disposition: Schema.Literal("postInit.stdin").annotations({
      description: "Init-only standard-input secret sink.",
    }),
  }).annotations(metadata("ConfigTranslateStdinSecretReference", "Approved standard-input secret sink.")),
  Schema.Struct({
    disposition: Schema.Literal("postInit.secretEnv").annotations({
      description: "Init-only environment secret sink.",
    }),
    name: Schema.String.annotations({ description: "Approved secret environment variable name." }),
  }).annotations(metadata("ConfigTranslateEnvSecretReference", "Approved environment secret sink.")),
).annotations(
  metadata(
    "ConfigTranslateSecretReference",
    "Approved secret reference or init-only sink; contains no raw secret.",
  ),
);
export const ConfigTranslateRecipeRequestInput = Schema.Struct({
  _tag: Schema.Literal("recipe-request").annotations({ description: "Recipe request discriminator." }),
  recipe: Schema.Struct({
    id: Schema.String.annotations({ description: "Recipe identity." }),
    version: Schema.String.annotations({ description: "Recipe version." }),
  }).annotations(metadata("ConfigTranslateRecipeIdentity", "Requested recipe identity and version.")),
  sourceId: ConfigTranslateSourceId.annotations({ description: "Core-assigned synthetic source identity." }),
  answers: Schema.Record({ key: Schema.String, value: ConfigTranslateAnswerValue }).annotations({
    description: "Schema-decoded nonsecret recipe answers.",
  }),
  secretAnswers: Schema.Record({ key: Schema.String, value: ConfigTranslateSecretReference }).annotations({
    description: "Approved secret references keyed by answer name.",
  }),
}).annotations(
  metadata("ConfigTranslateRecipeRequestInput", "One recipe request without filesystem discovery."),
);
export const ConfigTranslateInput = Schema.Union(
  ConfigTranslateDocumentSetInput,
  ConfigTranslateRecipeRequestInput,
).annotations(metadata("ConfigTranslateInput", "Explicit document-set or recipe translation request."));
export const ConfigTranslateDetectInput = Schema.Struct({
  documents: Schema.Array(ConfigTranslateDocument).annotations({
    description: "Core-read snapshots available for explicit detection.",
  }),
}).annotations(metadata("ConfigTranslateDetectInput", "Snapshot-only detection input."));
export const ConfigTranslateMatch = Schema.Struct({
  translator: Schema.String.annotations({ description: "Matching translator identity." }),
  sourceIds: Schema.Array(ConfigTranslateSourceId).annotations({
    description: "Matched snapshot source identities.",
  }),
  confidence: ConfigTranslateConfidence.annotations({ description: "Strength of the detection match." }),
  summary: Schema.optional(Schema.String.annotations({ description: "Human-readable detection summary." })),
}).annotations(metadata("ConfigTranslateMatch", "Explicit translator detection match."));

// ==== Provenance, diagnostics, and output ownership
export const ConfigTranslateDiagnosticKind = Schema.Literal(
  "generated",
  "dropped",
  "rewritten",
  "unsupported",
  "non-portable",
  "needs-review",
).annotations(metadata("ConfigTranslateDiagnosticKind", "Translation diagnostic classification."));
const Position = Schema.Struct({
  line: Schema.Int.annotations({ description: "Source line number." }),
  column: Schema.Int.annotations({ description: "Source column number." }),
}).annotations(metadata("ConfigTranslatePosition", "Source position for diagnostic ordering."));
export const ConfigTranslateSpan = Schema.Struct({
  start: Position.annotations({ description: "Start of the source span." }),
  end: Schema.optional(Position.annotations({ description: "Optional end of the source span." })),
}).annotations(metadata("ConfigTranslateSpan", "Diagnostic source span."));
export const ConfigTranslateDiagnostic = Schema.Struct({
  kind: ConfigTranslateDiagnosticKind.annotations({ description: "Diagnostic classification." }),
  sourceId: ConfigTranslateSourceId.annotations({
    description: "Input source responsible for the diagnostic.",
  }),
  keyPath: Schema.Array(Schema.Union(Schema.String, Schema.Int)).annotations({
    description: "Source object keys and array indices.",
  }),
  span: Schema.optional(ConfigTranslateSpan.annotations({ description: "Optional source location." })),
  message: Schema.String.annotations({ description: "Human-readable diagnostic message." }),
  remediation: Schema.optional(Schema.String.annotations({ description: "Suggested corrective action." })),
}).annotations(metadata("ConfigTranslateDiagnostic", "Source-attributed translation diagnostic."));
export const ConfigTranslateOutput = Schema.Struct({
  targetLayer: LandofileLayer.annotations({ description: "Unique allowlisted destination layer." }),
  fragment: authoringFragment("Authoring wire fragment for this output only."),
  sourceIds: Schema.Array(ConfigTranslateSourceId).annotations({
    description: "Input sources folded into this output.",
  }),
}).annotations(metadata("ConfigTranslateOutput", "One target-layer authoring output."));
export const ConfigTranslateDeletion = Schema.Struct({
  sourceId: ConfigTranslateSourceId.annotations({
    description: "Input document proposed for core-owned deletion.",
  }),
  reason: Schema.optional(Schema.String.annotations({ description: "Reason for the deletion intent." })),
}).annotations(metadata("ConfigTranslateDeletion", "Deletion intent, never a translator mutation."));
export const ConfigTranslateResult = Schema.Struct({
  outputs: Schema.Array(ConfigTranslateOutput).annotations({
    description: "Unique target-layer authoring fragments.",
  }),
  diagnostics: Schema.Array(ConfigTranslateDiagnostic).annotations({
    description: "Diagnostics ordered by document, source span, then key path.",
  }),
  deletions: Schema.Array(ConfigTranslateDeletion).annotations({
    description: "Deletion intents in canonical source order.",
  }),
}).annotations(
  metadata("ConfigTranslateResult", "Translation outputs with diagnostics and deletion intents."),
);
export const ConfigTranslateEncodeInput = Schema.Struct({
  context: authoringContext,
  fragment: Schema.optional(authoringFragment("Exact fragment to emit instead of the complete context.")),
}).annotations(
  metadata("ConfigTranslateEncodeInput", "Complete context and optional exact fragment for text encoding."),
);
export const ConfigTranslateEncodeResult = Schema.Struct({
  text: Schema.String.annotations({ description: "Encoded target text." }),
  diagnostics: Schema.Array(ConfigTranslateDiagnostic).annotations({
    description: "Ordered target-encoding diagnostics.",
  }),
}).annotations(metadata("ConfigTranslateEncodeResult", "Encoded text and target-specific diagnostics."));

// ==== Schema-inferred data types
export type ConfigTranslateSourceId = typeof ConfigTranslateSourceId.Type;
export type ConfigTranslateConfidence = typeof ConfigTranslateConfidence.Type;
export type ConfigTranslateMode = typeof ConfigTranslateMode.Type;
export type ConfigTranslateDocumentBytes = typeof ConfigTranslateDocumentBytes.Type;
export type ConfigTranslateDocument = typeof ConfigTranslateDocument.Type;
export type ConfigTranslateLayerFragment = typeof ConfigTranslateLayerFragment.Type;
export type ConfigTranslateDocumentSetInput = typeof ConfigTranslateDocumentSetInput.Type;
export type ConfigTranslateAnswerValue = typeof ConfigTranslateAnswerValue.Type;
export type ConfigTranslateSecretReference = typeof ConfigTranslateSecretReference.Type;
export type ConfigTranslateRecipeRequestInput = typeof ConfigTranslateRecipeRequestInput.Type;
export type ConfigTranslateInput = typeof ConfigTranslateInput.Type;
export type ConfigTranslateDetectInput = typeof ConfigTranslateDetectInput.Type;
export type ConfigTranslateMatch = typeof ConfigTranslateMatch.Type;
export type ConfigTranslateDiagnosticKind = typeof ConfigTranslateDiagnosticKind.Type;
export type ConfigTranslateSpan = typeof ConfigTranslateSpan.Type;
export type ConfigTranslateDiagnostic = typeof ConfigTranslateDiagnostic.Type;
export type ConfigTranslateOutput = typeof ConfigTranslateOutput.Type;
export type ConfigTranslateDeletion = typeof ConfigTranslateDeletion.Type;
export type ConfigTranslateResult = typeof ConfigTranslateResult.Type;
export type ConfigTranslateEncodeInput = typeof ConfigTranslateEncodeInput.Type;
export type ConfigTranslateEncodeResult = typeof ConfigTranslateEncodeResult.Type;
