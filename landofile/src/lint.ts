import { dirname } from "node:path";
import { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";
import { decodeLandofileLayer, mergeValues } from "@lando/sdk/landofile";
import { type ConfigLintResult, type ConfigLintViolation, LandofileShape } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { type ComposeRejectionMatch, analyzeComposeRejections } from "./compose/rejections.ts";
import { LANDOFILE_NAME, LANDOFILE_TS_NAME, findLandofilePath } from "./discovery.ts";
import { appNameOf, rejectionViolation, violationsFor } from "./lint-violations.ts";
import { buildLandofileLoadScope, materializeLandofileLayer } from "./pipeline/materialize.ts";
import type { TemplateEngineInputs } from "./ports.ts";
import { acquireLandofileRootLayers } from "./root-compile.ts";
import { resolveLandofileSourceExpressions } from "./source.ts";
import { landofileValidationError } from "./validation.ts";

export interface LintLandofileOptions {
  readonly cwd?: string;
  readonly templates?: TemplateEngineInputs;
}

const singleViolationResult = (
  file: string,
  message: string,
  details: {
    readonly line?: number | undefined;
    readonly column?: number | undefined;
    readonly suggestion?: string | undefined;
  } = {},
): ConfigLintResult => ({
  app: "",
  file,
  valid: false,
  violations: [
    {
      path: [],
      message,
      ...(details.line === undefined ? {} : { line: details.line }),
      ...(details.column === undefined ? {} : { column: details.column }),
      ...(details.suggestion === undefined ? {} : { suggestion: details.suggestion }),
    },
  ],
});

export const lintLandofile = Effect.fn("Landofile.lint")(function* (
  options: LintLandofileOptions = {},
): Effect.fn.Return<ConfigLintResult, LandofileNotFoundError | LandofileFormConflictError> {
  const cwd = options.cwd ?? process.cwd();
  const discovery = yield* Effect.tryPromise({
    try: () => findLandofilePath(cwd),
    catch: (cause) => cause,
  }).pipe(Effect.result);
  if (Result.isFailure(discovery)) {
    if (discovery.failure instanceof LandofileFormConflictError) return yield* Effect.fail(discovery.failure);
    return singleViolationResult(
      cwd,
      discovery.failure instanceof Error ? discovery.failure.message : "Failed to discover Landofile.",
    );
  }
  const filePath = discovery.success;
  if (filePath === undefined)
    return yield* Effect.fail(
      new LandofileNotFoundError({
        message: `No ${LANDOFILE_NAME} or ${LANDOFILE_TS_NAME} found. Searched from ${cwd} upward.`,
        cwd,
      }),
    );
  const sources = new Map<string, unknown>();
  const rejections = new Map<string, readonly ComposeRejectionMatch[]>();
  const result = yield* acquireLandofileRootLayers(
    dirname(filePath),
    options.templates === undefined ? undefined : { templates: options.templates },
  ).pipe(
    Effect.flatMap((acquired) =>
      Effect.gen(function* () {
        const prepared = yield* Effect.forEach(acquired.sources, ({ source, layer }) =>
          resolveLandofileSourceExpressions(source).pipe(
            Effect.map((value) => {
              sources.set(source.file, value.value);
              rejections.set(source.file, analyzeComposeRejections(value.value));
              return { source: value, layer };
            }),
          ),
        );
        const scope = yield* buildLandofileLoadScope(
          prepared.map(({ source }) => source),
          options.templates?.context?.env,
        );
        const compiled = yield* Effect.forEach(prepared, ({ source, layer }) =>
          materializeLandofileLayer(source.file, source.value, scope).pipe(
            Effect.flatMap((materialized) =>
              decodeLandofileLayer(source.file, materialized).pipe(
                Effect.catchTag("LandofileValidationError", (error) =>
                  Effect.fail(
                    error.message.startsWith("Invalid Landofile layer.")
                      ? landofileValidationError(source.file, [
                          ...(rejections.get(source.file) ?? []).map(rejectionViolation),
                          ...violationsFor(materialized, rejections.get(source.file) ?? []),
                        ])
                      : error,
                  ),
                ),
              ),
            ),
            Effect.map((landofile) => ({ layer, landofile })),
          ),
        );
        return { compiled };
      }),
    ),
    Effect.result,
  );
  if (Result.isFailure(result)) {
    const error = result.failure;
    if (error._tag === "LandofileFormConflictError") return yield* Effect.fail(error);
    if (error._tag === "LandofileValidationError")
      return {
        app: appNameOf(sources.get(error.file)),
        file: error.file,
        valid: false,
        violations: error.issues,
      };
    return singleViolationResult(
      "filePath" in error
        ? error.filePath
        : "conflictingLayer" in error
          ? error.conflictingLayer
          : "sourceFile" in error
            ? error.sourceFile
            : filePath,
      error.message,
      {
        line: "line" in error ? error.line : undefined,
        column: "column" in error ? error.column : undefined,
        suggestion: "remediation" in error ? error.remediation : undefined,
      },
    );
  }
  const decodedLayers = result.success.compiled;
  const parsed = decodedLayers.reduce<unknown>(
    (merged, { landofile }) => mergeValues(LandofileShape, merged, landofile),
    {},
  );
  const rejected = [...rejections.values()].flat();
  const violations: ConfigLintViolation[] = [];
  const keys = new Set<string>();
  const candidates = [
    ...rejected.map(rejectionViolation),
    ...violationsFor(parsed, rejected),
    ...decodedLayers.flatMap(({ layer, landofile }) =>
      violationsFor(mergeValues(LandofileShape, {}, landofile), rejections.get(layer.filePath) ?? []),
    ),
  ];
  for (const violation of candidates) {
    const key = JSON.stringify(violation);
    if (keys.has(key)) continue;
    keys.add(key);
    violations.push(violation);
  }
  return { app: appNameOf(parsed), file: filePath, valid: violations.length === 0, violations };
});
