import { Schema } from "effect";

const metadata = (identifier: string, description: string) => ({
  identifier,
  title: identifier,
  description,
});

// ==== Source identity and diagnostics (independent of authoring schemas)
export const ConfigTranslateSourceId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("ConfigTranslateSourceId"),
).annotate(
  metadata("ConfigTranslateSourceId", "Core-assigned document or synthetic recipe source identity."),
);

export const ConfigTranslateDiagnosticKind = Schema.Literals([
  "generated",
  "dropped",
  "rewritten",
  "unsupported",
  "non-portable",
  "needs-review",
]).annotate(metadata("ConfigTranslateDiagnosticKind", "Translation diagnostic classification."));

const Position = Schema.Struct({
  line: Schema.Int.annotate({ description: "Source line number." }),
  column: Schema.Int.annotate({ description: "Source column number." }),
}).annotate(metadata("ConfigTranslatePosition", "Source position for diagnostic ordering."));

export const ConfigTranslateSpan = Schema.Struct({
  start: Position.annotate({ description: "Start of the source span." }),
  end: Schema.optionalKey(Position.annotate({ description: "Optional end of the source span." })),
}).annotate(metadata("ConfigTranslateSpan", "Diagnostic source span."));

export const ConfigTranslateDiagnostic = Schema.Struct({
  kind: ConfigTranslateDiagnosticKind.annotate({ description: "Diagnostic classification." }),
  sourceId: ConfigTranslateSourceId.annotate({ description: "Input source responsible for the diagnostic." }),
  keyPath: Schema.Array(Schema.Union([Schema.String, Schema.Int])).annotate({
    description: "Source object keys and array indices.",
  }),
  span: Schema.optionalKey(ConfigTranslateSpan.annotate({ description: "Optional source location." })),
  message: Schema.String.annotate({ description: "Human-readable diagnostic message." }),
  remediation: Schema.optionalKey(Schema.String.annotate({ description: "Suggested corrective action." })),
}).annotate(metadata("ConfigTranslateDiagnostic", "Source-attributed translation diagnostic."));

export type ConfigTranslateSourceId = typeof ConfigTranslateSourceId.Type;
export type ConfigTranslateDiagnosticKind = typeof ConfigTranslateDiagnosticKind.Type;
export type ConfigTranslateSpan = typeof ConfigTranslateSpan.Type;
export type ConfigTranslateDiagnostic = typeof ConfigTranslateDiagnostic.Type;
