import { join } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import { LandofileLoadFailure } from "@lando/sdk/errors";
import { isPlainRecord } from "@lando/sdk/landofile";
import { LandofileAuthoringFragmentNative } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { rejectComposeKeys } from "./compose/rejections.ts";
import { withoutIncludeConditions } from "./include-condition-shape.ts";
import { type IncludeResolutionSession, createIncludeResolutionSession } from "./include-session.ts";
import { type PresentLandofileLayer, presentLandofileLayers } from "./layers.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import { assertReadableRoot, ensureConsistentRoot, loadContext } from "./load-context.ts";
import { finishLoadStage } from "./load-failures.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import { classifyLoadFailure } from "./pipeline/legacy.ts";
import { materializeLandofileLayer } from "./pipeline/materialize.ts";
import type { LandofileEvaluationInputs, LandofileRuntimeInputs } from "./ports.ts";
import type { SourceDocument } from "./provenance.ts";
import { prepareLandofileSource, prepareLandofileValue } from "./source.ts";
import { rejectUnsupportedToolingFeatures } from "./tooling-unsupported.ts";
import { validationErrorFromCause } from "./validation.ts";

export { loadAuthoredDocuments } from "./authored-documents.ts";

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
  selection?: { readonly layers: readonly PresentLandofileLayer[]; readonly contained: boolean },
) {
  const context = yield* loadContext(appRoot, inputs?.templates.context?.env);
  const runtime = selection?.contained
    ? { ...context, policy: { ...context.policy, allowOutsideRoot: false }, contained: true }
    : context;
  const layers = selection?.layers ?? (yield* presentLandofileLayers(appRoot));
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
    if (Result.isFailure(result)) {
      const classified = yield* Effect.fail(result.failure).pipe(
        Effect.catchTag(["LandofileParseError", "LandofileValidationError"], (error) =>
          classifyLoadFailure(
            error,
            appRoot,
            sources.map(({ source }) => sourceDocument(source)),
          ),
        ),
        Effect.result,
      );
      if (Result.isFailure(classified)) {
        const error = classified.failure;
        if (error._tag === "Lando3LandofileDetected" || error._tag === "LandofileDialectMixError")
          return yield* Effect.fail(error);
        runtime.recorder?.record(error, { kind: "missing-content" });
        if (runtime.recorder !== undefined) runtime.recorder.recipeAvailable = false;
      }
    }
  }
  return { runtime, sources };
});

export const acquireLandofileRootLayers = Effect.fn("Landofile.acquireLayers")(function* (
  appRoot: string,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
) {
  yield* ensureConsistentRoot(appRoot, inputs);
  const acquired = yield* acquireRootSources(appRoot, inputs);
  if (acquired.runtime.recorder !== undefined)
    yield* finishLoadStage(join(appRoot, ".lando.yml"), acquired.runtime.recorder);
  return acquired;
});

export const inspectLandofileRootLayers = Effect.fn("Landofile.inspectLayers")(function* (
  appRoot: string,
  inputs?: Pick<LandofileRuntimeInputs, "templates" | "transactionGuard">,
) {
  yield* assertReadableRoot(appRoot, inputs);
  return yield* acquireRootSources(appRoot, inputs);
});

const prepareRootSources = Effect.fn("Landofile.prepareSources")(function* ({
  runtime,
  sources,
}: Effect.Success<ReturnType<typeof acquireRootSources>>) {
  const prepared = yield* Effect.forEach(sources, ({ source, layer }) =>
    prepareLandofileValue(source).pipe(
      Effect.map(({ value }) => [
        {
          layer,
          landofile:
            runtime.recorder === undefined
              ? value
              : prepareIncludeAcquisition(value, {
                  recorder: runtime.recorder,
                  source: { file: layer.filePath, layer: layer.layer, path: [] },
                }),
        },
      ]),
      Effect.catch((error) => {
        if (!Schema.is(LandofileLoadFailure)(error)) return Effect.fail(error);
        runtime.recorder?.record(error, { kind: "missing-content" });
        return Effect.succeed([]);
      }),
    ),
  );
  return {
    runtime,
    sources,
    prepared: prepared.flat(),
    rootDocuments: sources.map(({ source }) => sourceDocument(source)),
  };
});

export const prepareLandofileRootLayers = Effect.fn("Landofile.prepareLayers")(function* (
  appRoot: string,
  inputs?: LandofileRuntimeInputs,
) {
  yield* ensureConsistentRoot(appRoot, inputs);
  return yield* prepareRootSources(yield* acquireRootSources(appRoot, inputs));
});

export const projectLandofileRootName = Effect.fnUntraced(function* (
  selection: { readonly appRoot: string; readonly canonicalPath: string } & NonNullable<
    Parameters<typeof acquireRootSources>[2]
  >,
  inputs: Pick<LandofileEvaluationInputs, "templates">,
) {
  const { appRoot, canonicalPath } = selection;
  const acquired = yield* acquireRootSources(appRoot, inputs, selection);
  const sources = acquired.sources.map(({ layer, source }) => {
    if (!isPlainRecord(source.value)) return { layer, source };
    const { name, recipe } = source.value;
    const value = {
      ...(Object.hasOwn(source.value, "name") ? { name } : {}),
      ...(Object.hasOwn(source.value, "recipe") ? { recipe } : {}),
    };
    return { layer, source: { ...source, value } };
  });
  // Includes cannot declare name or recipe; keeping only those fields makes this a local projection.
  const { prepared, runtime } = yield* prepareRootSources({ ...acquired, sources });
  const session = yield* createIncludeResolutionSession({ appRoot });
  const { document, scope } = yield* composePreparedLayers(prepared, runtime, { session });
  const { value } = yield* materializeLandofileLayer(canonicalPath, document, {
    ...scope,
    siteFilter: (site) => site.path[0] === "name",
  });
  if (runtime.recorder !== undefined) yield* finishLoadStage(canonicalPath, runtime.recorder);
  return typeof value.name === "string" ? value.name : undefined;
}, Effect.scoped);

export const validatePreparedAuthoringLayers = Effect.fnUntraced(function* (
  root: Effect.Success<ReturnType<typeof prepareLandofileRootLayers>>,
  includeMode: "conditional" | "all" = "conditional",
) {
  yield* Effect.forEach(root.prepared, ({ layer, landofile: authored }) => {
    const value = includeMode === "all" ? withoutIncludeConditions(authored.value) : authored.value;
    return rejectUnsupportedToolingFeatures(layer.filePath, value).pipe(
      Effect.flatMap((candidate) => rejectComposeKeys(layer.filePath, candidate)),
      Effect.flatMap(() =>
        Schema.decodeUnknownEffect(LandofileAuthoringFragmentNative)(value, {
          errors: "all",
          onExcessProperty: "error",
        }).pipe(mapFailures((cause) => validationErrorFromCause(layer.filePath, value, cause))),
      ),
    );
  }).pipe(
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
  evaluation: {
    readonly session: IncludeResolutionSession;
    readonly inputs?: LandofileEvaluationInputs;
    readonly selection?: Parameters<typeof acquireRootSources>[2];
  },
) {
  const prepared = yield* prepareRootSources(
    yield* acquireRootSources(appRoot, evaluation.inputs, evaluation.selection),
  );
  const { document: merged, scope } = yield* composePreparedLayers(
    prepared.prepared,
    prepared.runtime,
    evaluation,
  );
  return { ...prepared, merged, scope, session: evaluation.session, documents: merged.provenance.documents };
});

export const composeLandofileRootLayers = Effect.fn("Landofile.composeLayers")(function* (
  appRoot: string,
  inputs?: LandofileRuntimeInputs,
) {
  yield* ensureConsistentRoot(appRoot, inputs);
  const session = yield* createIncludeResolutionSession({ appRoot, ...inputs });
  const evaluated = yield* evaluateLandofileRootLayers(appRoot, {
    session,
    ...(inputs === undefined ? {} : { inputs }),
  });
  if (evaluated.runtime.recorder !== undefined) {
    yield* finishLoadStage(join(appRoot, ".lando.yml"), evaluated.runtime.recorder);
    yield* Effect.forEach(evaluated.runtime.recorder.effectiveChecks, (check) => check);
  }
  return evaluated;
}, Effect.scoped);
