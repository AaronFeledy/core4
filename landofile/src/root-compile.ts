import { LandofileFormConflictError, LandofileParseError } from "@lando/sdk/errors";
import { LandofileAuthoringFragmentNative } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { captureCompilationContext } from "./compilation.ts";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import { LANDOFILE_LAYER_POSITIONS, type PresentLandofileLayer, presentLandofileLayers } from "./layers.ts";
import { type LandofileLoadContext, ensureConsistentRoot, loadContext } from "./load-context.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { classifyLoadFailure } from "./pipeline/legacy.ts";
import { type SourceDocument, getSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { prepareLandofileContent, prepareLandofileSource, prepareLandofileValue } from "./source.ts";
import { validationErrorFromCause } from "./validation.ts";

export interface LandofileContentLayer extends PresentLandofileLayer {
  readonly content: string;
}
export type LandofileCompileError = Effect.Error<ReturnType<typeof loadLandofileContentLayers>>;
const sourceDocument = (
  source: Effect.Success<ReturnType<typeof prepareLandofileSource>>,
): SourceDocument => ({
  file: source.file,
  form: source.form,
  content: source.content,
  digest: source.digest,
  layer: source.context.layer,
  document: source.value,
});

export const acquireLandofileRootLayers = Effect.fn("Landofile.acquireLayers")(function* (
  appRoot: string,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
) {
  yield* ensureConsistentRoot(appRoot, inputs);
  const runtime = yield* loadContext(appRoot, inputs?.templates.context?.env);
  const layers = yield* Effect.tryPromise({
    try: () => presentLandofileLayers(appRoot),
    catch: (cause) =>
      cause instanceof LandofileFormConflictError
        ? cause
        : new LandofileParseError({
            message: "Failed to enumerate Landofile layers.",
            filePath: appRoot,
            line: undefined,
            column: undefined,
            cause,
          }),
  });
  const results = yield* Effect.forEach(layers, (layer) =>
    prepareLandofileSource(layer.filePath, { ...runtime, layer: layer.layer }, inputs).pipe(
      Effect.result,
      Effect.map((result) => ({ layer, result })),
    ),
  );
  const sources = results.flatMap(({ result, layer }) =>
    result._tag === "Success" ? [{ source: result.success, layer }] : [],
  );
  for (const { result } of results) {
    if (result._tag === "Failure")
      return yield* Effect.fail(result.failure).pipe(
        Effect.catchTag(["LandofileParseError", "LandofileValidationError"], (error) =>
          classifyLoadFailure(
            error,
            appRoot,
            sources.map(({ source }) => sourceDocument(source)),
          ),
        ),
      );
  }
  return { runtime, sources };
});

export const prepareLandofileRootLayers = Effect.fn("Landofile.prepareLayers")(function* (
  appRoot: string,
  inputs?: LandofileRuntimeInputs,
) {
  const { runtime, sources } = yield* acquireLandofileRootLayers(appRoot, inputs);
  const prepared = yield* Effect.forEach(sources, ({ source, layer }) =>
    prepareLandofileValue(source).pipe(Effect.map(({ value }) => ({ layer, landofile: value }))),
  ).pipe(
    Effect.catchTag(["LandofileParseError", "LandofileValidationError"], (error) =>
      classifyLoadFailure(
        error,
        appRoot,
        sources.map(({ source }) => sourceDocument(source)),
      ),
    ),
  );
  return { runtime, sources, prepared };
});

export const validatePreparedAuthoringLayers = Effect.fnUntraced(function* (
  root: Effect.Success<ReturnType<typeof prepareLandofileRootLayers>>,
) {
  yield* Effect.forEach(root.prepared, ({ layer, landofile }) =>
    Schema.decodeUnknownEffect(LandofileAuthoringFragmentNative)(landofile, {
      errors: "all",
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => validationErrorFromCause(layer.filePath, landofile, cause))),
  ).pipe(
    Effect.catchTag("LandofileValidationError", (error) =>
      classifyLoadFailure(
        error,
        root.runtime.appRoot,
        root.sources.map(({ source }) => sourceDocument(source)),
      ),
    ),
  );
  return root;
});

export const composeLandofileRootLayers = Effect.fn("Landofile.composeLayers")(function* (
  appRoot: string,
  inputs?: LandofileRuntimeInputs,
) {
  const prepared = yield* prepareLandofileRootLayers(appRoot, inputs);
  const merged = yield* composePreparedLayers(prepared.prepared, prepared.runtime, inputs);
  return { ...prepared, merged, documents: getSourceDocuments(merged) };
});

export const loadLandofileContentLayers = Effect.fn("Landofile.loadContentLayers")(function* (
  layers: readonly LandofileContentLayer[],
  runtime: Omit<LandofileLoadContext, "layer">,
  final: { readonly file: string; readonly forced?: Readonly<Record<string, unknown>> },
) {
  const pendingSites = runtime.pendingSites ?? [];
  const compilationContext = runtime.compilationContext ?? captureCompilationContext(runtime.appRoot);
  const prepared = yield* Effect.forEach(layers, (layer) =>
    prepareLandofileContent(layer.filePath, layer.content, {
      ...runtime,
      compilationContext,
      pendingSites,
      layer: layer.layer,
    }).pipe(Effect.map(({ value }) => ({ layer, landofile: value }))),
  );
  const document = yield* composePreparedLayers(prepared, { ...runtime, pendingSites });
  return yield* finalizeLandofile(
    final.file,
    copyLandofileProvenance(document, { ...document, ...final.forced }),
    {
      appRoot: runtime.appRoot,
      env: compilationContext.env,
      pendingSites,
      loadPolicy: runtime.policy,
      logger: runtime.logger,
    },
  );
});

export const loadAuthoredDocuments = Effect.fn("Landofile.loadDocuments")(function* (
  sources: readonly { readonly file: string; readonly value: unknown; readonly content?: string }[],
  context: {
    readonly appRoot: string;
    readonly file: string;
    readonly forced?: Readonly<Record<string, unknown>>;
  },
  inputs?: LandofileRuntimeInputs,
) {
  const pendingSites: import("@lando/sdk/schema").ParsedPendingSite[] = [];
  const compilationContext = captureCompilationContext(context.appRoot, inputs?.templates.context?.env);
  const prepared = yield* Effect.forEach(sources, (source) => {
    const position =
      LANDOFILE_LAYER_POSITIONS.find(
        ({ basename }) => source.file.endsWith(`${basename}.yml`) || source.file.endsWith(`${basename}.ts`),
      ) ?? LANDOFILE_LAYER_POSITIONS[3];
    const layer: PresentLandofileLayer = {
      filePath: source.file,
      layer: position?.layer ?? "canonical",
      order: position?.order ?? 3,
      basename: position?.basename ?? ".lando",
    };
    return prepareLandofileValue({
      ...source,
      context: {
        appRoot: context.appRoot,
        compilationContext,
        pendingSites,
        layer: layer.layer,
        policy: DEFAULT_LANDOFILE_LOAD_POLICY,
      },
    }).pipe(Effect.map(({ value }) => ({ layer, landofile: value })));
  });
  const document = yield* composePreparedLayers(
    prepared,
    {
      appRoot: context.appRoot,
      pendingSites,
      policy: DEFAULT_LANDOFILE_LOAD_POLICY,
    },
    inputs,
  );
  return yield* finalizeLandofile(
    context.file,
    copyLandofileProvenance(document, { ...document, ...context.forced }),
    { ...context, env: compilationContext.env, pendingSites },
  );
});
