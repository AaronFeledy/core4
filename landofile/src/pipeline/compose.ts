import { LandofileLoadFailure } from "@lando/sdk/errors";
import { type ValueWithOrigins, isPlainRecord, withValueOrigins } from "@lando/sdk/landofile";
import { Logger } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { unionEnvironmentDependencies } from "../environment-dependencies.ts";
import type { IncludeResolutionSession } from "../include-session.ts";
import { resolveLandofileIncludeLayers } from "../includes.ts";
import type { PresentLandofileLayer } from "../layers.ts";
import type { LandofileLoadContext } from "../load-context.ts";
import type { LandofileEvaluationInputs } from "../ports.ts";
import {
  type AuthoredDocument,
  type AuthoredOrigin,
  combineProvenance,
  emptyProvenance,
} from "../provenance.ts";
import { foldAuthoredOverlays } from "./fold.ts";
import { type LandofileLoadScope, buildLandofileLoadScope } from "./materialize.ts";

export const composePreparedLayers = Effect.fn("Landofile.compose")(function* (
  layers: readonly { readonly layer: PresentLandofileLayer; readonly landofile: AuthoredDocument }[],
  context: Omit<LandofileLoadContext, "layer">,
  evaluation: {
    readonly session: IncludeResolutionSession;
    readonly inputs?: LandofileEvaluationInputs;
    readonly scope?: LandofileLoadScope | undefined;
  },
) {
  const logger = yield* Effect.serviceOption(Logger);
  const loadScope = evaluation.scope ?? {
    ...(yield* buildLandofileLoadScope(
      layers.map(({ layer, landofile }) => ({ file: layer.filePath, value: landofile.value })),
      context.compilationContext?.env,
      context.pendingSites,
      context.environmentRecorder,
    )),
    recorder: context.recorder,
  };
  const fallback: AuthoredOrigin = {
    file: layers[0]?.layer.filePath ?? ".lando.yml",
    layer: layers[0]?.layer.layer ?? "canonical",
    path: [],
  };
  const loaded = yield* Effect.forEach(layers, ({ layer, landofile }) =>
    resolveLandofileIncludeLayers(
      {
        landofile,
        appRoot: context.appRoot,
        sourcePath: layer.filePath,
        layer: layer.layer,
        order: layer.order,
        resolveTooling: false,
        loadPolicy: context.policy,
        pendingSites: context.pendingSites,
        recorder: context.recorder,
        loadScope,
        ...(evaluation.inputs?.ports === undefined ? {} : { ports: evaluation.inputs.ports }),
        ...(evaluation.inputs?.stateStore === undefined ? {} : { stateStore: evaluation.inputs.stateStore }),
        ...(logger._tag === "None"
          ? {}
          : {
              onRelaxedRead: (read: import("../includes.ts").LandofileRelaxedRead) =>
                logger.value
                  .info("Landofile load used outside-root policy override", {
                    sourcePath: read.sourcePath,
                    authoredPath: read.authoredPath,
                    absolutePath: read.absolutePath,
                    appRoot: read.appRoot,
                  })
                  .pipe(Effect.catch(() => Effect.void)),
            }),
      },
      evaluation.session,
    ).pipe(
      Effect.catch((error) => {
        if (context.recorder === undefined || !Schema.is(LandofileLoadFailure)(error))
          return Effect.fail(error);
        context.recorder.record(error);
        return Effect.succeed({
          document: {
            value: {},
            provenance: emptyProvenance(withValueOrigins({}, () => fallback).origins),
          } satisfies AuthoredDocument,
          overlays: [] as readonly ValueWithOrigins<AuthoredOrigin>[],
        });
      }),
    ),
  );
  const overlays = loaded.flatMap(({ overlays }) => overlays);
  const folded = foldAuthoredOverlays(overlays, fallback);
  const provenance = combineProvenance(
    loaded.map(({ document }) => document.provenance),
    folded.origins,
  );
  const environment = unionEnvironmentDependencies(
    provenance.environmentDependencies,
    ...(loadScope.environmentRecorder === undefined ? [] : [loadScope.environmentRecorder.dependencies()]),
  );
  return {
    document: {
      value: isPlainRecord(folded.value) ? folded.value : {},
      provenance: { ...provenance, environmentDependencies: environment },
    },
    scope: loadScope,
  };
});
