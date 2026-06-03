import { Schema } from "effect";

// Config-lint result shapes — the stable, editor/LSP-facing output of
// `lando app:config:lint`. Validating a Landofile against the canonical
// `LandofileShape` schema yields zero or more structured violations. The
// JSON form of `ConfigLintResult` is the contract IDE integrations consume,
// so both shapes participate in the schema-snapshot gate.

/**
 * A single canonical-schema violation, addressed for inline editor
 * diagnostics.
 */
export const ConfigLintViolation = Schema.Struct({
  /** Dot-joined path to the offending node ("" for the document root). */
  path: Schema.String,
  /** Human-readable description of the violation. */
  message: Schema.String,
  /** Optional remediation hint (e.g. "Remove unknown key …"). */
  suggestedFix: Schema.optional(Schema.String),
  /** 1-based source line for diagnostics that can be located. */
  line: Schema.optional(Schema.Number),
  /** 1-based source column for diagnostics that can be located. */
  column: Schema.optional(Schema.Number),
});
export type ConfigLintViolation = typeof ConfigLintViolation.Type;

/**
 * The full result of linting one Landofile against the canonical schema.
 * `valid` is `true` iff `violations` is empty.
 */
export const ConfigLintResult = Schema.Struct({
  /** The linted app name (the Landofile `name:`, "" when unset). */
  app: Schema.String,
  /** Absolute path of the Landofile that was linted. */
  file: Schema.String,
  /** Whether the Landofile passed canonical-schema validation. */
  valid: Schema.Boolean,
  /** Ordered list of violations (empty when `valid`). */
  violations: Schema.Array(ConfigLintViolation),
});
export type ConfigLintResult = typeof ConfigLintResult.Type;
