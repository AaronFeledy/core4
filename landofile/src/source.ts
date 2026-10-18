import { dirname } from "node:path";
import { LandofileParseError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { rejectComposeKeys } from "./compose/rejections.ts";
import { type LegacyFailureSource, legacyLoadFailure } from "./legacy-load-failure.ts";
import { type LandofileLoadContext, ensureConsistentRoot } from "./load-context.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { resolveLandofileLoadExpressions } from "./load-expression.ts";
import { parseLandofile } from "./parser.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { scanContentForUnsupportedExpressions } from "./source-scan.ts";
import { buildTemplateEngineRegistry, renderLandofileTemplate } from "./template-render.ts";
import { rejectUnsupportedToolingFeatures } from "./tooling-unsupported.ts";
import { loadLandofileTs } from "./ts-loader.ts";

export const readFileContent = (filePath: string): Effect.Effect<string, LandofileParseError> =>
  Effect.tryPromise({
    try: async () => Bun.file(filePath).text(),
    catch: (cause) =>
      new LandofileParseError({
        message: cause instanceof Error ? cause.message : `Failed to read ${filePath}`,
        filePath,
        line: undefined,
        column: undefined,
        cause,
      }),
  });

const parseLandofileSource = (
  source: LegacyFailureSource,
  content: string,
  inputs?: Pick<LandofileRuntimeInputs, "templates">,
) =>
  renderLandofileTemplate({
    filePath: source.sourceFile,
    content,
    registry: buildTemplateEngineRegistry(inputs?.templates.modules ?? []),
    ...(inputs?.templates.context === undefined ? {} : { context: inputs.templates.context }),
  }).pipe(
    Effect.flatMap((rendered) => scanContentForUnsupportedExpressions(source.sourceFile, rendered)),
    Effect.flatMap((rendered) =>
      parseLandofile({
        file: source.sourceFile,
        content: rendered,
        cwd: dirname(source.sourceFile),
      }).pipe(Effect.catchTag("LandofileParseError", (error) => legacyLoadFailure(error, content, source))),
    ),
  );

export const prepareLandofileSource = Effect.fn("Landofile.prepareSource")(function* (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
) {
  const resolvedContext = context ?? {
    appRoot: dirname(filePath),
    layer: "canonical" as const,
    policy: DEFAULT_LANDOFILE_LOAD_POLICY,
  };
  yield* ensureConsistentRoot(resolvedContext.appRoot, inputs);
  const content = filePath.endsWith(".ts") ? undefined : yield* readFileContent(filePath);
  const parsed = yield* content === undefined
    ? readFileContent(filePath).pipe(
        Effect.flatMap((content) => loadLandofileTs({ filePath, appRoot: dirname(filePath), content })),
      )
    : parseLandofileSource({ ...resolvedContext, sourceFile: filePath }, content, inputs);
  return { file: filePath, value: parsed, content, context: resolvedContext };
});

export const prepareLandofileContent = Effect.fn("Landofile.prepareContent")(function* (
  filePath: string,
  content: string,
  context: LandofileLoadContext,
) {
  const value = yield* parseLandofileSource({ ...context, sourceFile: filePath }, content);
  const checked = yield* checkLandofileSource(filePath, value);
  return yield* resolveLandofileSourceExpressions({ file: filePath, content, value: checked, context });
});

export const resolveLandofileSourceExpressions = Effect.fn("Landofile.resolveSourceExpressions")(function* (
  source: Effect.Success<ReturnType<typeof prepareLandofileSource>>,
) {
  const { file, value, content, context } = source;
  const resolved = yield* resolveLandofileLoadExpressions({
    value,
    source: { appRoot: context.appRoot, sourcePath: file, sourceRoot: dirname(file), layer: context.layer },
    policy: context.policy,
  });
  if (context.logger !== undefined) {
    const logger = context.logger;
    yield* Effect.forEach(resolved.relaxedReads, (read) =>
      logger
        .info("Landofile load used outside-root policy override", {
          sourcePath: file,
          authoredPath: read.authoredPath,
          absolutePath: read.absolutePath,
          appRoot: context.appRoot,
        })
        .pipe(Effect.catch(() => Effect.void)),
    );
  }
  return { file, value: resolved.value, content, context, dependencies: resolved.dependencies };
});

const checkLandofileSource = Effect.fnUntraced(function* (file: string, value: unknown) {
  return yield* rejectUnsupportedToolingFeatures(file, value).pipe(
    Effect.flatMap((supported) => rejectComposeKeys(file, supported)),
  );
});

export const prepareLandofileLayer = Effect.fn("Landofile.prepareLayer")(function* (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
) {
  const source = yield* prepareLandofileSource(filePath, context, inputs);
  const checked = yield* checkLandofileSource(filePath, source.value);
  return yield* resolveLandofileSourceExpressions({ ...source, value: checked });
});
