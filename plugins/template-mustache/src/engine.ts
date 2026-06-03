/**
 * Mustache whole-file template engine.
 *
 * Logic-less by design — no helper concept. Useful for cross-language templates
 * a user already maintains in Mustache form.
 *
 * HTML escaping is DISABLED: Mustache escapes `&`, `<`, `>`, `"` by default,
 * which would corrupt YAML config values. Since this engine renders config
 * files, we pass a pass-through `escape` via the per-render config (NOT the
 * process-global `Mustache.escape`, which would disable escaping for every
 * other Mustache user in the process). Mustache has no strict mode, so a
 * missing key renders empty (its documented logic-less behavior); only
 * malformed tags fail, at compile time, with a template-source location.
 */
import { Effect } from "effect";
import Mustache from "mustache";

import type { TemplateRenderContext } from "@lando/sdk/schema";
import {
  type CompiledTemplate,
  TemplateCompileError,
  type TemplateCompileInput,
  type TemplateEngine,
  TemplateRenderError,
} from "@lando/sdk/template";

const ENGINE_ID = "mustache" as const;
const EXTENSIONS = [".mustache"] as const;

const noEscape = (value: string): string => value;

interface SourceLocation {
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}

/** Convert a 0-based character offset into a 1-based line/column in `source`. */
const offsetToLocation = (source: string, offset: number): SourceLocation => {
  const bounded = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let column = 1;
  for (let index = 0; index < bounded; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
};

/** Mustache throws `Error("... at <offset>")` on malformed tags. */
const extractLocation = (source: string, error: unknown): SourceLocation => {
  if (error !== null && typeof error === "object") {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") {
      const match = message.match(/at (\d+)/);
      if (match !== null) return offsetToLocation(source, Number(match[1]));
    }
  }
  return {};
};

const compile = (input: TemplateCompileInput): Effect.Effect<CompiledTemplate, TemplateCompileError> =>
  Effect.try({
    try: () => {
      // Eagerly parse so malformed tags surface now with a source location.
      Mustache.parse(input.source);
      const run = (context: TemplateRenderContext): string =>
        Mustache.render(input.source, context as unknown as Record<string, unknown>, undefined, {
          escape: noEscape,
        });
      return { engineId: ENGINE_ID, sourceId: input.id, run };
    },
    catch: (cause) => {
      const location = extractLocation(input.source, cause);
      return new TemplateCompileError({
        message: cause instanceof Error ? cause.message : "Mustache template failed to compile.",
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
    catch: (cause) =>
      new TemplateRenderError({
        message: cause instanceof Error ? cause.message : "Mustache template failed to render.",
        engineId: ENGINE_ID,
        sourceId: template.sourceId,
        line: undefined,
        column: undefined,
        cause,
      }),
  });

/** The Mustache `TemplateEngine` implementation. */
export const mustacheEngine: TemplateEngine = {
  id: ENGINE_ID,
  extensions: EXTENSIONS,
  capabilities: { wholeFile: true, stringInterpolation: false, partials: false, unsafe: false },
  compile,
  render,
};

export default mustacheEngine;
