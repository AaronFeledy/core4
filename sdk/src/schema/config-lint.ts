import { Schema } from "effect";

import { ValidationIssue, ValidationIssuePath } from "./validation-issue.ts";

// Config-lint result shapes — the stable, editor/LSP-facing output of
// `lando app:config:lint`. Validating a Landofile against the canonical
// `LandofileShape` schema yields zero or more structured violations. The
// JSON form of `ConfigLintResult` is the contract IDE integrations consume,
// so both shapes participate in the schema-snapshot gate.

/**
 * A single config lint finding, addressed for inline editor
 * diagnostics.
 */
export const ConfigLintViolation = Schema.Struct({
  rule: Schema.String.annotate({ description: "Stable diagnostic rule identifier." }),
  severity: Schema.Literals(["error", "warning"]).annotate({
    description: "Whether the finding prevents configuration validity.",
  }),
  /** Object keys and array indexes. Empty for the document root. */
  path: ValidationIssuePath,
  /** Human-readable description of the violation. */
  message: Schema.String,
  /** Likely fix, such as the closest allowed key or a Compose disposition. */
  suggestion: Schema.optionalKey(Schema.String),
  /** 1-based source line for diagnostics that can be located. */
  line: Schema.optionalKey(Schema.Number),
  /** 1-based source column for diagnostics that can be located. */
  column: Schema.optionalKey(Schema.Number),
  scopes: Schema.optionalKey(
    Schema.Array(Schema.Literals(["fragment", "effective"])).annotate({
      description: "Scopes containing this defect, ordered fragment then effective without duplicates.",
    }),
  ),
  source: ValidationIssue.fields.source,
});
export type ConfigLintViolation = typeof ConfigLintViolation.Type;

/**
 * The full result of linting one Landofile against the canonical schema.
 * `valid` is true when no error-severity violation exists.
 */
export const ConfigLintResult = Schema.Struct({
  /** The linted app name (the Landofile `name:`, "" when unset). */
  app: Schema.String,
  /** Absolute path of the Landofile that was linted. */
  file: Schema.String,
  /** Whether the Landofile has no error-severity finding. */
  valid: Schema.Boolean,
  /** Ordered findings, including warnings that do not invalidate configuration. */
  violations: Schema.Array(ConfigLintViolation),
});
export type ConfigLintResult = typeof ConfigLintResult.Type;
