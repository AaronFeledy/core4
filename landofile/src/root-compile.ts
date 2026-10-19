import {
  type Lando3LandofileDetected,
  type LandofileDialectMixError,
  LandofileFormConflictError,
  LandofileParseError,
} from "@lando/sdk/errors";
import type { LandofileDecodedOverlay } from "@lando/sdk/landofile";
import { Effect, Result } from "effect";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import { type LandofileLoadScope, buildLandofileLoadScope, compileLandofileLayer } from "./compile.ts";
import { type PresentLandofileLayer, presentLandofileLayers } from "./layers.ts";
import { legacyLoadFailure } from "./legacy-load-failure.ts";
import { type LandofileLoadContext, ensureConsistentRoot, loadContext } from "./load-context.ts";
import { rememberLandofileReferencedFiles } from "./load-expression-provenance.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { hostExpressionEnvironment } from "./recipe-expressions.ts";
import { prepareLandofileContent, prepareLandofileLayer, readFileContent } from "./source.ts";

export type PreparedLandofileLayer = Effect.Success<ReturnType<typeof prepareLandofileLayer>>;
export type LandofileLayerCompileError =
  | Effect.Error<ReturnType<typeof compileLandofileLayer>>
  | Lando3LandofileDetected
  | LandofileDialectMixError;
export type LandofileCompileError =
  | LandofileLayerCompileError
  | Effect.Error<ReturnType<typeof prepareLandofileLayer>>
  | LandofileFormConflictError;

export const compilePreparedLayer: (
  prepared: PreparedLandofileLayer,
  scope: LandofileLoadScope,
  compileLayer?: typeof compileLandofileLayer,
) => Effect.Effect<LandofileDecodedOverlay, LandofileLayerCompileError> = Effect.fnUntraced(function* (
  prepared: PreparedLandofileLayer,
  scope: LandofileLoadScope,
  compileLayer = compileLandofileLayer,
): Effect.fn.Return<LandofileDecodedOverlay, LandofileLayerCompileError> {
  const { file, content, context } = prepared;
  const landofile = yield* compileLayer(file, prepared.value, scope).pipe(
    Effect.catch((error) =>
      content === undefined
        ? Effect.fail(error)
        : legacyLoadFailure(error, content, { ...context, sourceFile: file }),
    ),
  );
  return rememberLandofileAppRoot(
    rememberLandofileReferencedFiles(landofile, prepared.dependencies),
    context.appRoot,
  );
});

export interface LandofileCompilationStages {
  readonly prepare: (
    file: string,
    context: LandofileLoadContext,
    inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
  ) => ReturnType<typeof prepareLandofileLayer>;
  readonly compile: typeof compilePreparedLayer;
  readonly readContent: typeof readFileContent;
}

const runtimeStages: LandofileCompilationStages = {
  prepare: prepareLandofileLayer,
  compile: compilePreparedLayer,
  readContent: readFileContent,
};

export interface CompiledLandofileRootLayers {
  readonly compiled: readonly {
    readonly layer: PresentLandofileLayer;
    readonly landofile: LandofileDecodedOverlay;
  }[];
  readonly scope: LandofileLoadScope;
  readonly runtime: Effect.Success<ReturnType<typeof loadContext>>;
}

export interface LandofileContentLayer extends PresentLandofileLayer {
  readonly content: string;
}

export const compileLandofileContentLayers = (
  layers: readonly LandofileContentLayer[],
  runtime: CompiledLandofileRootLayers["runtime"],
): Effect.Effect<CompiledLandofileRootLayers, LandofileCompileError> => {
  const contents = new Map(layers.map((layer) => [layer.filePath, layer.content]));
  const readContent = (file: string): Effect.Effect<string, LandofileParseError> => {
    const content = contents.get(file);
    return content === undefined
      ? Effect.fail(
          new LandofileParseError({
            message: `Landofile source ${file} is unavailable.`,
            filePath: file,
            line: undefined,
            column: undefined,
          }),
        )
      : Effect.succeed(content);
  };
  return compileLandofileSourceLayers(layers, runtime, undefined, {
    readContent,
    prepare: (file, context) =>
      readContent(file).pipe(Effect.flatMap((content) => prepareLandofileContent(file, content, context))),
    compile: compilePreparedLayer,
  });
};

export const compileLandofileRootLayers = Effect.fn("Landofile.compileRootLayers")(function* (
  appRoot: string,
  canonicalPath: string,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
  stages: LandofileCompilationStages = runtimeStages,
): Effect.fn.Return<CompiledLandofileRootLayers, LandofileCompileError> {
  yield* ensureConsistentRoot(appRoot, inputs);
  const runtime = yield* loadContext(appRoot);
  const layers = yield* Effect.tryPromise({
    try: () => presentLandofileLayers(appRoot),
    catch: (cause) =>
      cause instanceof LandofileFormConflictError
        ? cause
        : new LandofileParseError({
            message: cause instanceof Error ? cause.message : "Failed to enumerate Landofile layers.",
            filePath: canonicalPath,
            line: undefined,
            column: undefined,
            cause,
          }),
  });
  return yield* compileLandofileSourceLayers(layers, runtime, inputs, stages);
});

export const compileLandofileSourceLayers = Effect.fn("Landofile.compileSourceLayers")(function* (
  layers: readonly PresentLandofileLayer[],
  runtime: CompiledLandofileRootLayers["runtime"],
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
  stages: LandofileCompilationStages = runtimeStages,
): Effect.fn.Return<CompiledLandofileRootLayers, LandofileCompileError> {
  const appRoot = runtime.appRoot;
  const canonical = layers.find((layer) => layer.layer === "canonical");
  const canonicalPreparation =
    canonical === undefined
      ? undefined
      : yield* stages
          .prepare(canonical.filePath, { ...runtime, layer: canonical.layer }, inputs)
          .pipe(Effect.result);
  const prepared = yield* Effect.forEach(layers, (layer) =>
    (layer === canonical && canonicalPreparation !== undefined
      ? Effect.succeed(canonicalPreparation)
      : stages.prepare(layer.filePath, { ...runtime, layer: layer.layer }, inputs).pipe(Effect.result)
    ).pipe(Effect.map((result) => ({ result, layer }))),
  );
  const raw = prepared.flatMap(({ result, layer }) =>
    Result.isSuccess(result) ? [{ ...result.success, layer }] : [],
  );
  const env = inputs?.templates.context?.env ?? hostExpressionEnvironment();
  if (canonicalPreparation !== undefined && Result.isFailure(canonicalPreparation)) {
    return yield* Effect.fail(canonicalPreparation.failure);
  }
  const failedPreparation = prepared.find(({ result }) => Result.isFailure(result));
  if (failedPreparation !== undefined && Result.isFailure(failedPreparation.result)) {
    const error = failedPreparation.result.failure;
    if (
      (error._tag !== "LandofileParseError" && error._tag !== "LandofileValidationError") ||
      canonicalPreparation === undefined
    )
      return yield* Effect.fail(error);
    const checkedCanonical = yield* buildLandofileLoadScope(raw, env).pipe(
      Effect.flatMap((scope) => stages.compile(canonicalPreparation.success, scope)),
      Effect.result,
    );
    if (Result.isFailure(checkedCanonical)) return yield* Effect.fail(error);
    const content = yield* stages.readContent(failedPreparation.layer.filePath);
    return yield* legacyLoadFailure(error, content, {
      appRoot,
      sourceFile: failedPreparation.layer.filePath,
      validCanonicalFile: canonicalPreparation.success.file,
    });
  }
  const scope = yield* buildLandofileLoadScope(raw, env).pipe(
    Effect.catch((error) => {
      const source = raw.find(
        (source) => source.file === (error._tag === "LandofileValidationError" ? error.file : error.filePath),
      );
      return source?.content === undefined
        ? Effect.fail(error)
        : legacyLoadFailure(error, source.content, { ...source.context, sourceFile: source.file });
    }),
  );
  const canonicalResult =
    canonicalPreparation === undefined
      ? undefined
      : yield* stages.compile(canonicalPreparation.success, scope).pipe(Effect.result);
  const validCanonicalFile =
    canonicalResult !== undefined && Result.isSuccess(canonicalResult) ? canonical?.filePath : undefined;
  const compiled = yield* Effect.forEach(raw, (preparedLayer) => {
    const layer: PresentLandofileLayer = preparedLayer.layer;
    const context = {
      ...runtime,
      layer: layer.layer,
      ...(validCanonicalFile === undefined ? {} : { validCanonicalFile }),
    };
    return (
      layer === canonical && canonicalResult !== undefined
        ? Effect.fromResult(canonicalResult)
        : stages.compile({ ...preparedLayer, context }, scope)
    ).pipe(Effect.map((landofile) => ({ layer, landofile })));
  });
  return { compiled, scope, runtime };
});
