import { LandofileAuthoringFragmentNative } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { captureCompilationContext } from "./compilation.ts";
import {
  type IncludeResolutionSession,
  createIncludeResolutionSession,
  publishIncludeProposals,
} from "./include-session.ts";
import { LANDOFILE_LAYER_POSITIONS, type PresentLandofileLayer, presentLandofileLayers } from "./layers.ts";
import { assertReadableRoot, ensureConsistentRoot, loadContext } from "./load-context.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { classifyLoadFailure } from "./pipeline/legacy.ts";
import { type SourceDocument, getSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileEvaluationInputs, LandofileRuntimeInputs } from "./ports.ts";
import { prepareLandofileSource, prepareLandofileValue } from "./source.ts";
import { validationErrorFromCause } from "./validation.ts";

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

const acquireRootSources = Effect.fn("Landofile.acquireSources")(function* (
  appRoot: string,
  inputs?: Pick<LandofileEvaluationInputs, "templates">,
) {
  const runtime = yield* loadContext(appRoot, inputs?.templates.context?.env);
  const layers = yield* presentLandofileLayers(appRoot);
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

export const acquireLandofileRootLayers = Effect.fn("Landofile.acquireLayers")(function* (
  appRoot: string,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
) {
  yield* ensureConsistentRoot(appRoot, inputs);
  return yield* acquireRootSources(appRoot, inputs);
});

export const inspectLandofileRootLayers = Effect.fn("Landofile.inspectLayers")(function* (
  appRoot: string,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
) {
  yield* assertReadableRoot(appRoot, inputs);
  return yield* acquireRootSources(appRoot, inputs);
});

const prepareRootSources = Effect.fn("Landofile.prepareSources")(function* (
  appRoot: string,
  inputs?: LandofileEvaluationInputs,
) {
  const { runtime, sources } = yield* acquireRootSources(appRoot, inputs);
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

export const prepareLandofileRootLayers = Effect.fn("Landofile.prepareLayers")(function* (
  appRoot: string,
  inputs?: LandofileRuntimeInputs,
) {
  yield* ensureConsistentRoot(appRoot, inputs);
  return yield* prepareRootSources(appRoot, inputs);
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

export const evaluateLandofileRootLayers = Effect.fn("Landofile.evaluateLayers")(function* (
  appRoot: string,
  evaluation: { readonly session: IncludeResolutionSession; readonly inputs?: LandofileEvaluationInputs },
) {
  const prepared = yield* prepareRootSources(appRoot, evaluation.inputs);
  const merged = yield* composePreparedLayers(prepared.prepared, prepared.runtime, evaluation);
  return { ...prepared, merged, session: evaluation.session, documents: getSourceDocuments(merged) };
});

export const composeLandofileRootLayers = Effect.fn("Landofile.composeLayers")(function* (
  appRoot: string,
  inputs?: LandofileRuntimeInputs,
) {
  yield* ensureConsistentRoot(appRoot, inputs);
  const session = yield* createIncludeResolutionSession({ appRoot, ...inputs });
  return yield* evaluateLandofileRootLayers(appRoot, {
    session,
    ...(inputs === undefined ? {} : { inputs }),
  });
});

export const loadAuthoredDocuments = Effect.fn("Landofile.loadDocuments")(function* (
  sources: readonly { readonly file: string; readonly value: unknown; readonly content?: string }[],
  context: {
    readonly appRoot: string;
    readonly file: string;
  },
  inputs?: LandofileRuntimeInputs,
) {
  yield* ensureConsistentRoot(context.appRoot, inputs);
  const session = yield* createIncludeResolutionSession({ appRoot: context.appRoot, ...inputs });
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
    { session, ...(inputs === undefined ? {} : { inputs }) },
  );
  const compiled = yield* finalizeLandofile(context.file, document, {
    ...context,
    env: compilationContext.env,
    pendingSites,
  });
  yield* publishIncludeProposals(session, inputs?.stateStore);
  return compiled;
});
