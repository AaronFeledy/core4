/**
 * Programmatic `recipe.ts` loader.
 *
 * A `recipe.ts` is the TypeScript counterpart to `recipe.yml`: it
 * default-exports either a static `Recipe` value or a factory
 * `(ctx) => Recipe`. The module is loaded through Bun's native TS loader
 * (no `tsc` step), its top-level imports are sandbox-scanned (mirroring the
 * `.lando.ts` rule), and module evaluation is bounded by a timeout. The
 * resolved value is returned untyped; callers validate it against the
 * canonical `RecipeManifest` schema.
 */
import { dirname } from "node:path";

import { Clock, Duration, Effect } from "effect";

import { RecipeManifestParseError, causeMessage } from "@lando/sdk/errors";
import type { RecipeContext } from "@lando/sdk/schema";

import { isSandboxParseFailure, resolveTsModuleResult, sandboxScan } from "@lando/landofile/ts-loader";

export const DEFAULT_RECIPE_TS_TIMEOUT_MS = 30_000;
export const RECIPE_TS_TIMEOUT_ENV = "LANDO_RECIPE_TS_TIMEOUT_MS";

export const resolveRecipeTimeoutMs = (): number => {
  const raw = process.env[RECIPE_TS_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return DEFAULT_RECIPE_TS_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECIPE_TS_TIMEOUT_MS;
  return parsed;
};

const parseError = (filePath: string, message: string, cause?: unknown): RecipeManifestParseError =>
  new RecipeManifestParseError({
    message,
    source: filePath,
    line: undefined,
    column: undefined,
    ...(cause === undefined ? {} : { cause }),
  });

const buildContext = (filePath: string): RecipeContext => ({
  cwd: dirname(filePath),
  env: process.env,
});

const unwrapDefault = async (filePath: string, module: unknown): Promise<unknown> => {
  if (module === null || typeof module !== "object") {
    throw parseError(filePath, `recipe.ts at ${filePath} did not export a module object.`);
  }
  const exported = (module as { default?: unknown }).default;
  if (exported === undefined) {
    throw parseError(filePath, `recipe.ts at ${filePath} is missing a default export.`);
  }
  if (typeof exported === "function") {
    const ctx = buildContext(filePath);
    return await resolveTsModuleResult((exported as (ctx: RecipeContext) => unknown)(ctx));
  }
  return await resolveTsModuleResult(exported);
};

const evaluateImport = Effect.fnUntraced(function* (
  filePath: string,
): Effect.fn.Return<unknown, RecipeManifestParseError> {
  const timestamp = yield* Clock.currentTimeMillis;
  return yield* Effect.tryPromise({
    try: async () => {
      const module = await import(`${filePath}?t=${timestamp}`);
      return await unwrapDefault(filePath, module);
    },
    catch: (cause) =>
      cause instanceof RecipeManifestParseError
        ? cause
        : parseError(filePath, `Failed to load recipe.ts at ${filePath}: ${causeMessage(cause)}`, cause),
  });
});

export interface LoadRecipeTsOptions {
  readonly filePath: string;
  readonly recipeRoot: string;
  readonly content: string;
  readonly timeoutMs?: number;
}

export const loadRecipeTs = Effect.fnUntraced(function* (
  options: LoadRecipeTsOptions,
): Effect.fn.Return<unknown, RecipeManifestParseError> {
  yield* sandboxScan(options.filePath, options.recipeRoot, options.content).pipe(
    Effect.mapError((cause) =>
      isSandboxParseFailure(cause)
        ? parseError(
            options.filePath,
            `recipe.ts at ${options.filePath} could not be parsed as TypeScript: ${causeMessage(cause.cause)}`,
            cause,
          )
        : parseError(
            options.filePath,
            `recipe.ts at ${options.filePath} has a disallowed import: ${cause.violation}. Programmatic recipes must not perform host shell-outs, remote module fetches, or filesystem access outside the recipe directory.`,
            cause,
          ),
    ),
  );
  const timeoutMs = options.timeoutMs ?? resolveRecipeTimeoutMs();
  return yield* Effect.timeoutOrElse(evaluateImport(options.filePath), {
    duration: Duration.millis(timeoutMs),
    orElse: () =>
      Effect.fail(
        (() =>
          parseError(
            options.filePath,
            `recipe.ts at ${options.filePath} did not produce a value within ${timeoutMs}ms.`,
          ))(),
      ),
  });
});
