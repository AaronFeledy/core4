import { Schema } from "effect";
import { ConfigLintRuleId } from "./config-lint-rules.ts";
import { LandofileLayer } from "./landofile-reference.ts";

// =============================================================================
// Shared diagnostic contracts
// =============================================================================

export const ValidationIssuePath = Schema.Array(Schema.Union([Schema.String, Schema.Number])).annotate({
  description:
    "Location of the issue: object keys as strings, array positions as numbers. Empty for the document root.",
});
export type ValidationIssuePath = typeof ValidationIssuePath.Type;

export const ValidationIssueSource = Schema.Union([
  Schema.Struct({
    file: Schema.String.annotate({ description: "Authored Landofile or fragment containing the value." }),
    layer: LandofileLayer.annotate({ description: "Root layer that contributed the authored value." }),
    path: ValidationIssuePath.annotate({
      description: "Original authored path before alias canonicalization or list relocation.",
    }),
  }),
  Schema.Struct({
    layer: Schema.Literals(["config-file", "config-drop-in"]),
    file: Schema.String,
    path: ValidationIssuePath,
  }),
  Schema.Struct({
    layer: Schema.Literal("script"),
    file: Schema.String,
    path: ValidationIssuePath,
  }),
  Schema.Struct({
    layer: Schema.Literal("env"),
    variable: Schema.String,
    path: ValidationIssuePath,
  }),
  Schema.Struct({ layer: Schema.Literal("host"), path: ValidationIssuePath }),
  Schema.Struct({ layer: Schema.Literal("default"), path: ValidationIssuePath }),
]);
export type ValidationIssueSource = typeof ValidationIssueSource.Type;

export const ValidationIssue = Schema.Struct({
  reason: Schema.optionalKey(Schema.String).annotate({
    description: "Stable machine-readable reason within the diagnostic rule, when known.",
  }),
  rule: Schema.optionalKey(ConfigLintRuleId).annotate({
    description:
      "Registered diagnostic rule identifier. Plugins must use a registered identifier or omit rule.",
  }),
  path: ValidationIssuePath,
  kind: Schema.optionalKey(Schema.Literals(["type", "value", "missing", "unexpected"])).annotate({
    description:
      "Decoder classification: type means the value has the wrong JSON kind for every accepted form; value means the kind fits but a literal, enum, range, pattern, or other check rejects it; missing means a required key is absent; unexpected means the key is not allowed. Omitted when unknown.",
  }),
  message: Schema.String.annotate({ description: "Human-readable description of the problem." }),
  suggestion: Schema.optionalKey(Schema.String).annotate({
    description: "Likely fix, such as the closest allowed key for an unknown key.",
  }),
  source: Schema.optionalKey(ValidationIssueSource).annotate({
    description: "Physical source of the effective value, when known.",
  }),
  related: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: ValidationIssuePath.annotate({ description: "Related declaration's effective path." }),
        source: Schema.optionalKey(ValidationIssueSource).annotate({
          description: "Physical source of the related declaration, when known.",
        }),
      }),
    ),
  ).annotate({
    description: "Other declaration locations needed to explain the conflict; no authored values.",
  }),
}).annotate({ identifier: "ValidationIssue" });
export type ValidationIssue = typeof ValidationIssue.Type;
