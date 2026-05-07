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
export const ToolingDisabled = Schema.Union(Schema.Literal(false), Schema.Literal("disabled"));

/**
 * `ToolingSpec` — the parsed-and-validated input shape from a Landofile.
 *
 * TODO: expand to the full schema.
 */
export const ToolingSpec = Schema.Struct({
  service: Schema.optional(Schema.String),
  cmd: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
  description: Schema.optional(Schema.String),
  bootstrap: Schema.optional(Schema.Literal("tooling", "provider", "app")),
  engine: Schema.optional(Schema.String),
  passThrough: Schema.optional(Schema.Boolean),
  parallel: Schema.optional(Schema.Boolean),
  interactive: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Boolean),
});
export type ToolingSpec = typeof ToolingSpec.Type;
