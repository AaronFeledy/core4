/**
 * Tooling schema.
 *
 * `tooling.<name>` accepts `service`, `cmd`, `description`, `usage`,
 * `examples`, `user`, `dir`, `env`, `appMount`, `stdio`, `bootstrap`,
 * `engine`, `flags`, `args`, `passThrough`, `parallel`, `interactive`,
 * `disabled`.
 *
 * `cmd` can be: string | string[] | multi-line string | array of
 * `{<service>: <cmd>}` objects.
 *
 * Dynamic service resolution:
 *   - `service: <name>` — fixed
 *   - `service: :flag-name` — value from `--flag-name` flag
 *   - `service: :host` — bypass the provider, run on host (uses `ProcessRunner`)
 *
 * Status: stub.
 */
import { Schema } from "effect";

/** Tooling spec literal "disabled" forms. */
export const ToolingDisabled = Schema.Union([Schema.Literal(false), Schema.Literal("disabled")]);

/**
 * `ToolingSpec` — the parsed-and-validated input shape from a Landofile.
 *
 * TODO: expand to the full schema.
 */
export const ToolingSpec = Schema.Struct({
  service: Schema.optionalKey(Schema.String),
  cmd: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  description: Schema.optionalKey(Schema.String),
  bootstrap: Schema.optionalKey(Schema.Literals(["tooling", "provider", "app"])),
  engine: Schema.optionalKey(Schema.String),
  passThrough: Schema.optionalKey(Schema.Boolean),
  parallel: Schema.optionalKey(Schema.Boolean),
  interactive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
});
export type ToolingSpec = typeof ToolingSpec.Type;
