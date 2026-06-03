/**
 * Handlebars whole-file template engine.
 *
 * Configured with `noEscape: true` (config-file rendering must NOT HTML-escape
 * YAML values like `&`, `<`, `"`) and `strict: true` (missing context fields
 * fail loudly rather than rendering empty). Syntax errors are surfaced at
 * compile time with template-source line/column; the Landofile parse seam maps
 * those into `LandofileParseError`.
 */
import { Effect } from "effect";
import Handlebars from "handlebars";

import type { TemplateRenderContext } from "@lando/sdk/schema";
import {
  type CompiledTemplate,
  TemplateCompileError,
  type TemplateCompileInput,
  type TemplateEngine,
  TemplateRenderError,
} from "@lando/sdk/template";

const ENGINE_ID = "handlebars" as const;
const EXTENSIONS = [".hbs", ".handlebars"] as const;

const HANDLEBARS_OPTIONS: CompileOptions = { noEscape: true, strict: true };

interface SourceLocation {
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}

/**
 * Pull a template-SOURCE line/column out of a Handlebars error. Parse errors
 * from the lexer carry `hash.loc.{first_line,first_column}`; runtime/strict
 * errors carry `lineNumber`/`column`; otherwise fall back to the
 * `"... on line N"` text embedded in the message.
 */
const extractLocation = (error: unknown): SourceLocation => {
  if (error === null || typeof error !== "object") return {};
  const record = error as {
    readonly hash?: { readonly loc?: { readonly first_line?: unknown; readonly first_column?: unknown } };
    readonly lineNumber?: unknown;
    readonly column?: unknown;
    readonly message?: unknown;
  };

  const loc = record.hash?.loc;
  if (loc !== undefined && typeof loc.first_line === "number") {
    return {
      line: loc.first_line,
      // Handlebars columns are 0-based; report 1-based.
      column: typeof loc.first_column === "number" ? loc.first_column + 1 : undefined,
    };
  }

  if (typeof record.lineNumber === "number") {
    return {
      line: record.lineNumber,
      column: typeof record.column === "number" ? record.column : undefined,
    };
  }

  if (typeof record.message === "string") {
    const match = record.message.match(/line (\d+)/i);
    if (match !== null) return { line: Number(match[1]) };
  }

  return {};
};

const compile = (input: TemplateCompileInput): Effect.Effect<CompiledTemplate, TemplateCompileError> =>
  Effect.try({
    try: () => {
      // Compile lazily, then force an eager parse so syntax errors surface now
      // (with source location) rather than on first render.
      const template = Handlebars.compile<TemplateRenderContext>(input.source, HANDLEBARS_OPTIONS);
      Handlebars.parse(input.source);
      const run = (context: TemplateRenderContext): string => template(context, {});
      return { engineId: ENGINE_ID, sourceId: input.id, run };
    },
    catch: (cause) => {
      const location = extractLocation(cause);
      return new TemplateCompileError({
        message: cause instanceof Error ? cause.message : "Handlebars template failed to compile.",
        engineId: ENGINE_ID,
        sourceId: input.id,
        line: location.line,
        column: location.column,
        cause,
      });
    },
  });

const render = (
  template: CompiledTemplate,
  context: TemplateRenderContext,
): Effect.Effect<string, TemplateRenderError> =>
  Effect.try({
    try: () => template.run(context),
    catch: (cause) => {
      const location = extractLocation(cause);
      return new TemplateRenderError({
        message: cause instanceof Error ? cause.message : "Handlebars template failed to render.",
        engineId: ENGINE_ID,
        sourceId: template.sourceId,
        line: location.line,
        column: location.column,
        cause,
      });
    },
  });

/** The Handlebars `TemplateEngine` implementation. */
export const handlebarsEngine: TemplateEngine = {
  id: ENGINE_ID,
  extensions: EXTENSIONS,
  capabilities: { wholeFile: true, stringInterpolation: false, partials: true, unsafe: false },
  compile,
  render,
};

export default handlebarsEngine;
