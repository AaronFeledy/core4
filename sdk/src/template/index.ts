/**
 * `@lando/sdk/template` — pluggable template-engine contracts (§7.3.2).
 *
 * Whole-file template rendering is pluggable. Core ships the `lando` engine
 * (the §7.3.1 expression language, built in) as the default; the bundled
 * `@lando/template-handlebars` and `@lando/template-mustache` plugins provide
 * whole-file rendering of users' existing `.hbs` / `.mustache` templates.
 *
 * This subpath is type/contract only (like `@lando/sdk/expressions`). It is NOT
 * a `Context.Tag` service and its errors deliberately live here rather than on
 * the frozen `@lando/sdk/errors` barrel — pre-parse Landofile rendering maps
 * them into `LandofileParseError` at the parse seam, so the frozen
 * `LandofileService.discover` error union is never widened.
 */
import { type Effect, Schema } from "effect";

import type { TemplateRenderContext } from "../schema/index.ts";

/** Capability flags a template engine declares (§7.3.2). */
export interface TemplateEngineCapabilities {
  /** Multi-line render with control flow. */
  readonly wholeFile: boolean;
  /**
   * Single-string render for Landofile string-value interpolation. Only the
   * built-in `lando` engine may set this `true` — its syntax IS the Landofile
   * expression contract. Plugin engines render whole files only.
   */
  readonly stringInterpolation: boolean;
  /** Engine supports named partials. */
  readonly partials: boolean;
  /** Engine cannot guarantee §7.3.1 purity (disabled by default when `true`). */
  readonly unsafe: boolean;
}

/** Input to {@link TemplateEngine.compile}. */
export interface TemplateCompileInput {
  /** Stable id for the template source — typically the file path. */
  readonly id: string;
  /** Raw template source text. */
  readonly source: string;
}

/** A compiled, content-addressable template ready to render. */
export interface CompiledTemplate {
  /** Id of the engine that produced this compiled template. */
  readonly engineId: string;
  /** Id of the source (file path) the template was compiled from. */
  readonly sourceId: string;
  /**
   * Engine-internal render thunk. MAY throw on render failure; engine
   * implementations wrap this in {@link TemplateEngine.render} and map thrown
   * failures to {@link TemplateRenderError}.
   */
  readonly run: (context: TemplateRenderContext) => string;
}

/**
 * A pluggable template engine. The canonical shape from spec §7.3.2.
 *
 * `compile` parses the source eagerly so syntax errors surface with
 * template-source line/column. `render` evaluates a compiled template against
 * the canonical {@link TemplateRenderContext}.
 */
export interface TemplateEngine {
  /** Unique engine id (e.g. `handlebars`, `mustache`). `lando` is reserved. */
  readonly id: string;
  /** Default file extensions this engine claims (e.g. `.hbs`). */
  readonly extensions: ReadonlyArray<string>;
  /** Engine capability flags. */
  readonly capabilities: TemplateEngineCapabilities;
  /** Compile source → a {@link CompiledTemplate}; fails on syntax error. */
  readonly compile: (input: TemplateCompileInput) => Effect.Effect<CompiledTemplate, TemplateCompileError>;
  /** Render a compiled template with a context; fails on render error. */
  readonly render: (
    template: CompiledTemplate,
    context: TemplateRenderContext,
  ) => Effect.Effect<string, TemplateRenderError>;
}

/** Template failed to compile (syntax error). Carries source line/column. */
export class TemplateCompileError extends Schema.TaggedError<TemplateCompileError>()("TemplateCompileError", {
  message: Schema.String,
  engineId: Schema.String,
  sourceId: Schema.String,
  line: Schema.UndefinedOr(Schema.Number),
  column: Schema.UndefinedOr(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

/** Template failed to render (e.g. strict missing field). Carries source line/column. */
export class TemplateRenderError extends Schema.TaggedError<TemplateRenderError>()("TemplateRenderError", {
  message: Schema.String,
  engineId: Schema.String,
  sourceId: Schema.String,
  line: Schema.UndefinedOr(Schema.Number),
  column: Schema.UndefinedOr(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

/** A requested template engine id is not installed / resolvable. */
export class TemplateEngineUnresolvedError extends Schema.TaggedError<TemplateEngineUnresolvedError>()(
  "TemplateEngineUnresolvedError",
  {
    message: Schema.String,
    engineId: Schema.String,
    remediation: Schema.String,
  },
) {}
