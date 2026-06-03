/**
 * Pre-parse Landofile template rendering (§7.3.2).
 *
 * A Landofile MAY opt into whole-file template rendering by declaring a
 * template engine on its first content line:
 *
 * ```yaml
 * template: handlebars
 * name: {{ env.APP_NAME }}
 * ```
 *
 * Rendering runs BEFORE YAML parse because a Handlebars/Mustache body is not
 * valid YAML. The directive line is blanked (not deleted) before rendering so
 * the engine sees the same line count — template syntax/render errors surface
 * with the user's TEMPLATE-SOURCE line numbers — and so the synthetic
 * `template:` key never reaches the strict `LandofileShape` decode.
 *
 * Default is `none`: with no directive the raw content is returned unchanged,
 * so existing Landofiles are byte-for-byte unaffected.
 *
 * Template failures (`TemplateCompileError` / `TemplateRenderError` / unresolved
 * engine) are mapped to `LandofileParseError` here, at the parse seam, so the
 * frozen `LandofileService.discover` error union is never widened.
 */
import { Effect } from "effect";

import { LandofileParseError } from "@lando/sdk/errors";
import type { TemplateRenderContext } from "@lando/sdk/schema";
import type { TemplateEngine } from "@lando/sdk/template";

import { BUNDLED_PLUGINS } from "../plugins/bundled.ts";

/** A resolved set of template engines, keyed by engine id. */
export type TemplateEngineRegistry = ReadonlyMap<string, TemplateEngine>;

/** Engine id that explicitly opts OUT of rendering (same as no directive). */
const NONE_ENGINE = "none";

/**
 * A leading template directive: an UNINDENTED `template: <engine-id>` line.
 * Engine ids are lower-case kebab (`[a-z][a-z0-9-]*`), case-sensitive — the
 * same shape engines declare for their `id`.
 */
const DIRECTIVE_PATTERN = /^template:[ \t]*([a-z][a-z0-9-]*)[ \t]*$/;

export interface TemplateDirective {
  readonly engineId: string;
  /** 0-based index of the directive line in the source. */
  readonly lineIndex: number;
}

/**
 * Detect a leading `template: <engine>` directive. Leading blank lines and
 * full-line `#` comments are skipped; the directive must be the FIRST real
 * content line. Anything else (e.g. a normal `name:` first key) means no
 * directive — raw YAML.
 */
export const detectTemplateDirective = (content: string): TemplateDirective | undefined => {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    const match = raw.match(DIRECTIVE_PATTERN);
    if (match === null) return undefined;
    return { engineId: match[1] as string, lineIndex: index };
  }
  return undefined;
};

/** Blank a single line in place (keeping the newline) to preserve line count. */
const blankLine = (content: string, lineIndex: number): string => {
  const lines = content.split("\n");
  lines[lineIndex] = "";
  return lines.join("\n");
};

const buildBundledRegistry = (): TemplateEngineRegistry => {
  const registry = new Map<string, TemplateEngine>();
  for (const plugin of BUNDLED_PLUGINS) {
    if (plugin.templateEngines === undefined) continue;
    for (const [id, engine] of plugin.templateEngines) {
      if (!registry.has(id)) registry.set(id, engine);
    }
  }
  return registry;
};

/** The template engines contributed by bundled plugins (handlebars, mustache). */
export const bundledTemplateEngineRegistry: TemplateEngineRegistry = buildBundledRegistry();

const parseError = (
  filePath: string,
  message: string,
  line: number | undefined,
  column: number | undefined,
  cause?: unknown,
): LandofileParseError =>
  new LandofileParseError({
    message,
    filePath,
    line,
    column,
    ...(cause === undefined ? {} : { cause }),
  });

const stringEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
};

/** Minimal pre-planning render context — no `service.*` / `info.*` (§7.3.2). */
const defaultRenderContext = (): TemplateRenderContext => ({
  bootstrapLevel: "app",
  env: stringEnv(),
  scope: "landofile",
});

export interface RenderLandofileTemplateOptions {
  readonly filePath: string;
  readonly content: string;
  /** Override the engine registry (default: bundled engines). */
  readonly registry?: TemplateEngineRegistry;
  /** Override the render context (default: env-only, app level). */
  readonly context?: TemplateRenderContext;
}

/**
 * Render a Landofile through its declared template engine (if any). With no
 * directive (or `template: none`) the content is returned unchanged.
 */
export const renderLandofileTemplate = (
  options: RenderLandofileTemplateOptions,
): Effect.Effect<string, LandofileParseError> => {
  const { filePath, content } = options;
  const directive = detectTemplateDirective(content);
  if (directive === undefined) return Effect.succeed(content);

  const blanked = blankLine(content, directive.lineIndex);
  if (directive.engineId === NONE_ENGINE) return Effect.succeed(blanked);

  const registry = options.registry ?? bundledTemplateEngineRegistry;
  const engine = registry.get(directive.engineId);
  const directiveLine = directive.lineIndex + 1;
  if (engine === undefined) {
    const available = [...registry.keys()].sort();
    const remediation =
      available.length === 0
        ? "No template engines are installed."
        : `Install the matching plugin or use one of: ${available.join(", ")}.`;
    return Effect.fail(
      parseError(
        filePath,
        `Unknown template engine "${directive.engineId}". ${remediation}`,
        directiveLine,
        1,
      ),
    );
  }

  return engine.compile({ id: filePath, source: blanked }).pipe(
    Effect.mapError((error) => parseError(filePath, error.message, error.line, error.column, error.cause)),
    Effect.flatMap((compiled) =>
      engine
        .render(compiled, options.context ?? defaultRenderContext())
        .pipe(
          Effect.mapError((error) =>
            parseError(filePath, error.message, error.line, error.column, error.cause),
          ),
        ),
    ),
  );
};
