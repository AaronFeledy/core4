import { Schema, SchemaTransformation } from "effect";
import { ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "./config-translate-diagnostic.ts";
export {
  ConfigTranslateDiagnostic,
  ConfigTranslateDiagnosticKind,
  ConfigTranslateSourceId,
  ConfigTranslateSpan,
} from "./config-translate-diagnostic.ts";
import { LandofileAuthoringFragmentWire, LandofileAuthoringShapeWire } from "./landofile-authoring.ts";
import { LandofileLayer } from "./landofile-reference.ts";
import { PortablePath, ServiceName } from "./primitives.ts";
import { SHA256_PREFIXED_DIGEST_PATTERN, patternString } from "./string-forms.ts";

const SECRET_REFERENCE_PATTERN = /^\$\{secret:[^}]+\}$/;

// ==== Source snapshots and translation requests
const metadata = (identifier: string, description: string) => ({
  identifier,
  title: identifier,
  description,
});
interface AuthoringFragmentSchema
  extends Schema.Codec<Schema.Schema.Type<typeof LandofileAuthoringFragmentWire>> {}
interface AuthoringContextSchema
  extends Schema.Codec<Schema.Schema.Type<typeof LandofileAuthoringShapeWire>> {}
const authoringFragment = (description: string): AuthoringFragmentSchema =>
  LandofileAuthoringFragmentWire.annotate({ description });
const authoringContext: AuthoringContextSchema = LandofileAuthoringShapeWire.annotate({
  description: "Complete validated authoring wire context.",
});
export const ConfigTranslateConfidence = Schema.Literals(["exact", "likely", "possible"]).annotate(
  metadata("ConfigTranslateConfidence", "Translator detection confidence."),
);
export const ConfigTranslateMode = Schema.Literals(["full", "single-layer"]).annotate(
  metadata("ConfigTranslateMode", "Full document-set or selected-layer conversion."),
);
export const ConfigTranslateDocumentBytes = Schema.Uint8ArrayFromBase64.from
  .annotate({
    format: undefined,
    contentEncoding: undefined,
    description: "Bounded raw source bytes, encoded as base64 on the wire.",
  })
  .pipe(Schema.decodeTo(Schema.Uint8Array, SchemaTransformation.uint8ArrayFromBase64String));
export const ConfigTranslateDocument = Schema.Struct({
  sourceId: ConfigTranslateSourceId.annotate({ description: "Stable identity assigned to this source." }),
  layerId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
    description: "Foreign source layer identity.",
  }),
  path: Schema.optionalKey(PortablePath.annotate({ description: "App-relative source path." })),
  mediaType: Schema.String.annotate({ description: "Source media type." }),
  contentDigest: patternString(SHA256_PREFIXED_DIGEST_PATTERN, {
    toJsonSchema: () => ({ pattern: SHA256_PREFIXED_DIGEST_PATTERN.source }),
  }).annotate({
    description: "SHA-256 digest of the raw source bytes.",
  }),
  bytes: ConfigTranslateDocumentBytes,
}).annotate(metadata("ConfigTranslateDocument", "Core-read immutable source snapshot."));
export const ConfigTranslateLayerFragment = Schema.Struct({
  layerId: LandofileLayer.annotate({ description: "Existing lower v4 layer." }),
  fragment: authoringFragment("Lower-layer authoring wire fragment."),
}).annotate(metadata("ConfigTranslateLayerFragment", "Authoring context for a lower layer."));
export const ConfigTranslateDocumentSetInput = Schema.Struct({
  _tag: Schema.Literal("landofile-document-set").annotate({
    description: "Document-set request discriminator.",
  }),
  documents: Schema.Array(ConfigTranslateDocument).annotate({
    description: "Source snapshots in canonical document order.",
  }),
  mode: ConfigTranslateMode.annotate({ description: "Requested conversion scope." }),
  selectedSourceIds: Schema.Array(ConfigTranslateSourceId).annotate({
    description: "Selected sources; nonempty for single-layer conversion.",
  }),
  currentLowerV4Fragments: Schema.Array(ConfigTranslateLayerFragment).annotate({
    description: "Already validated lower-layer context.",
  }),
  writableLayerIds: Schema.Array(LandofileLayer).annotate({
    description: "Nonempty output-layer allowlist.",
  }),
}).annotate(metadata("ConfigTranslateDocumentSetInput", "One ordered document set to translate."));
const AnswerScalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
export const ConfigTranslateAnswerValue = Schema.Union([AnswerScalar, Schema.Array(AnswerScalar)]).annotate(
  metadata("ConfigTranslateAnswerValue", "Nonsecret scalar or scalar-array recipe answer."),
);
export const ConfigTranslateSecretReference = Schema.Union([
  Schema.Struct({
    disposition: Schema.Literal("secret-store").annotate({ description: "Stored-secret disposition." }),
    reference: patternString(SECRET_REFERENCE_PATTERN, {
      toJsonSchema: () => ({ pattern: SECRET_REFERENCE_PATTERN.source }),
    }).annotate({
      description: "One canonical ${secret:...} reference, never the secret value.",
    }),
  }).annotate(metadata("ConfigTranslateStoredSecretReference", "Approved stored-secret reference.")),
  Schema.Struct({
    disposition: Schema.Literal("postInit.stdin").annotate({
      description: "Init-only standard-input secret sink.",
    }),
  }).annotate(metadata("ConfigTranslateStdinSecretReference", "Approved standard-input secret sink.")),
  Schema.Struct({
    disposition: Schema.Literal("postInit.secretEnv").annotate({
      description: "Init-only environment secret sink.",
    }),
    name: Schema.String.annotate({ description: "Approved secret environment variable name." }),
  }).annotate(metadata("ConfigTranslateEnvSecretReference", "Approved environment secret sink.")),
]).annotate(
  metadata(
    "ConfigTranslateSecretReference",
    "Approved secret reference or init-only sink; contains no raw secret.",
  ),
);
export const ConfigTranslateRecipeRequestInput = Schema.Struct({
  _tag: Schema.Literal("recipe-request").annotate({ description: "Recipe request discriminator." }),
  recipe: Schema.Struct({
    id: Schema.String.annotate({ description: "Recipe identity." }),
    version: Schema.String.annotate({ description: "Recipe version." }),
  }).annotate(metadata("ConfigTranslateRecipeIdentity", "Requested recipe identity and version.")),
  sourceId: ConfigTranslateSourceId.annotate({ description: "Core-assigned synthetic source identity." }),
  answers: Schema.Record(Schema.String, ConfigTranslateAnswerValue).annotate({
    description: "Schema-decoded nonsecret recipe answers.",
  }),
  secretAnswers: Schema.Record(Schema.String, ConfigTranslateSecretReference).annotate({
    description: "Approved secret references keyed by answer name.",
  }),
}).annotate(
  metadata("ConfigTranslateRecipeRequestInput", "One recipe request without filesystem discovery."),
);
export const ConfigTranslateInput = Schema.Union([
  ConfigTranslateDocumentSetInput,
  ConfigTranslateRecipeRequestInput,
]).annotate(metadata("ConfigTranslateInput", "Explicit document-set or recipe translation request."));
export const ConfigTranslateDetectInput = Schema.Struct({
  documents: Schema.Array(ConfigTranslateDocument).annotate({
    description: "Core-read snapshots available for explicit detection.",
  }),
}).annotate(metadata("ConfigTranslateDetectInput", "Snapshot-only detection input."));
export const ConfigTranslateMatch = Schema.Struct({
  translator: Schema.String.annotate({ description: "Matching translator identity." }),
  sourceIds: Schema.Array(ConfigTranslateSourceId).annotate({
    description: "Matched snapshot source identities.",
  }),
  confidence: ConfigTranslateConfidence.annotate({ description: "Strength of the detection match." }),
  summary: Schema.optionalKey(Schema.String.annotate({ description: "Human-readable detection summary." })),
}).annotate(metadata("ConfigTranslateMatch", "Explicit translator detection match."));

// ==== Provenance, diagnostics, and output ownership
export const ConfigTranslateOutput = Schema.Struct({
  targetLayer: LandofileLayer.annotate({ description: "Unique allowlisted destination layer." }),
  fragment: authoringFragment("Authoring wire fragment for this output only."),
  sourceIds: Schema.Array(ConfigTranslateSourceId).annotate({
    description: "Input sources folded into this output.",
  }),
}).annotate(metadata("ConfigTranslateOutput", "One target-layer authoring output."));
export const ConfigTranslateDeletion = Schema.Struct({
  sourceId: ConfigTranslateSourceId.annotate({
    description: "Input document proposed for core-owned deletion.",
  }),
  reason: Schema.optionalKey(Schema.String.annotate({ description: "Reason for the deletion intent." })),
}).annotate(metadata("ConfigTranslateDeletion", "Deletion intent, never a translator mutation."));
export const ConfigTranslateExpectation = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("PersistedHome").annotate({
      description: "Home persistence expectation discriminator.",
    }),
    sourceId: ConfigTranslateSourceId.annotate({
      description: "Input source responsible for the expectation.",
    }),
    keyPath: Schema.Array(Schema.Union([Schema.String, Schema.Int])).annotate({
      description: "Source object keys and array indices.",
    }),
    service: ServiceName.annotate({
      description: "Converted Lando 4 service whose home the source persisted.",
    }),
  }),
]).annotate(
  metadata(
    "ConfigTranslateExpectation",
    "Source-attributed intent assessed by the host against the final converted configuration.",
  ),
);
export const ConfigTranslateResult = Schema.Struct({
  outputs: Schema.Array(ConfigTranslateOutput).annotate({
    description: "Unique target-layer authoring fragments.",
  }),
  diagnostics: Schema.Array(ConfigTranslateDiagnostic).annotate({
    description: "Diagnostics ordered by document, source span, then key path.",
  }),
  deletions: Schema.Array(ConfigTranslateDeletion).annotate({
    description: "Deletion intents in canonical source order.",
  }),
  expectations: Schema.optionalKey(
    Schema.Array(ConfigTranslateExpectation).annotate({
      description: "Source expectations for host assessment against the final merged authoring context.",
    }),
  ),
}).annotate(metadata("ConfigTranslateResult", "Translation outputs with diagnostics and deletion intents."));
export const ConfigTranslateEncodeInput = Schema.Struct({
  context: authoringContext,
  fragment: Schema.optionalKey(authoringFragment("Exact fragment to emit instead of the complete context.")),
}).annotate(
  metadata("ConfigTranslateEncodeInput", "Complete context and optional exact fragment for text encoding."),
);
export const ConfigTranslateEncodeResult = Schema.Struct({
  text: Schema.String.annotate({ description: "Encoded target text." }),
  diagnostics: Schema.Array(ConfigTranslateDiagnostic).annotate({
    description: "Ordered target-encoding diagnostics.",
  }),
}).annotate(metadata("ConfigTranslateEncodeResult", "Encoded text and target-specific diagnostics."));

// ==== Schema-inferred data types
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
export type ConfigTranslateOutput = typeof ConfigTranslateOutput.Type;
export type ConfigTranslateDeletion = typeof ConfigTranslateDeletion.Type;
export type ConfigTranslateExpectation = typeof ConfigTranslateExpectation.Type;
export type ConfigTranslateResult = typeof ConfigTranslateResult.Type;
export type ConfigTranslateEncodeInput = typeof ConfigTranslateEncodeInput.Type;
export type ConfigTranslateEncodeResult = typeof ConfigTranslateEncodeResult.Type;
