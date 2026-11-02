import { LandofileLoadFailure } from "@lando/sdk/errors";
import { Logger } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import {
  getLandofileIncludeSources,
  getLocalIncludePaths,
  rememberLandofileIncludeSources,
  rememberLocalIncludePaths,
} from "../include-provenance.ts";
import type { IncludeResolutionSession } from "../include-session.ts";
import { resolveLandofileIncludeLayers } from "../includes.ts";
import type { PresentLandofileLayer } from "../layers.ts";
import type { LandofileLoadContext } from "../load-context.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "../load-expression-provenance.ts";
import type { LandofileEvaluationInputs } from "../ports.ts";
import { getVersionConstraintEntries, rememberVersionConstraintEntries } from "../version-constraint.ts";
import { foldAuthoredOverlays } from "./fold.ts";
import { type LandofileLoadScope, buildLandofileLoadScope } from "./materialize.ts";
import type { AuthoredOrigin } from "./prepare.ts";
import { getSourceDocuments, rememberSourceDocuments } from "./source-table.ts";

export const composePreparedLayers = Effect.fn("Landofile.compose")(function* (
  layers: readonly { readonly layer: PresentLandofileLayer; readonly landofile: Record<string, unknown> }[],
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
      layers.map(({ layer, landofile }) => ({ file: layer.filePath, value: landofile })),
      context.compilationContext?.env,
      context.pendingSites,
    )),
    recorder: context.recorder,
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
      Effect.map((resolved) => ({ ...resolved, layer })),
      Effect.catch((error) => {
        if (context.recorder === undefined || !Schema.is(LandofileLoadFailure)(error))
          return Effect.fail(error);
        context.recorder.record(error);
        return Effect.succeed({ layer, provenance: {}, overlays: [] });
      }),
    ),
  );
  const overlays = loaded.flatMap(({ overlays }) => overlays);
  const fallback: AuthoredOrigin = {
    file: layers[0]?.layer.filePath ?? ".lando.yml",
    layer: layers[0]?.layer.layer ?? "canonical",
    path: [],
  };
  const document = foldAuthoredOverlays(overlays, fallback);
  rememberSourceDocuments(
    document,
    loaded.flatMap(({ provenance }) => getSourceDocuments(provenance)),
  );
  rememberLandofileReferencedFiles(
    document,
    loaded.flatMap(({ provenance }) => getLandofileReferencedFiles(provenance)),
  );
  rememberLocalIncludePaths(
    document,
    loaded.flatMap(({ provenance }) => getLocalIncludePaths(provenance)),
  );
  rememberLandofileIncludeSources(
    document,
    loaded.flatMap(({ provenance }) => getLandofileIncludeSources(provenance)),
  );
  rememberVersionConstraintEntries(
    document,
    loaded.flatMap(({ provenance, layer }) => getVersionConstraintEntries(provenance, layer.filePath)),
  );
  return { document, scope: loadScope };
});
