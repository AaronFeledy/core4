import { dirname } from "node:path";
import { Effect } from "effect";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import { createIncludeResolutionSession, publishIncludeProposals } from "./include-session.ts";
import { LANDOFILE_LAYER_POSITIONS, type PresentLandofileLayer } from "./layers.ts";
import { type LandofileLoadContext, ensureConsistentRoot } from "./load-context.ts";
import { createLoadFailureRecorder } from "./load-failures.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { classifyLoadFailure } from "./pipeline/legacy.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import { getSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { prepareLandofileSource, prepareLandofileValue } from "./source.ts";

export const compileLandofileFile = Effect.fn("Landofile.loadPreparedFile")(function* (
  file: string,
  context?: LandofileLoadContext,
  inputs?: LandofileRuntimeInputs,
  scope?: LandofileLoadScope,
) {
  yield* ensureConsistentRoot(context?.appRoot ?? dirname(file), inputs);
  const source = yield* prepareLandofileSource(file, context, inputs);
  const recorder = context?.recorder ?? createLoadFailureRecorder();
  const prepared = yield* prepareLandofileValue({ ...source, context: { ...source.context, recorder } });
  const appRoot = source.context.appRoot;
  const layer: PresentLandofileLayer = {
    filePath: file,
    basename: ".lando",
    layer: source.context.layer,
    order: LANDOFILE_LAYER_POSITIONS.find((position) => position.layer === source.context.layer)?.order ?? 3,
  };
  const session = yield* createIncludeResolutionSession({ appRoot, ...inputs });
  const { document: merged, scope: loadScope } = yield* composePreparedLayers(
    [{ layer, landofile: prepared.value }],
    { ...source.context, recorder },
    {
      session,
      scope,
      ...(inputs === undefined ? {} : { inputs }),
    },
  );
  const landofile = yield* finalizeLandofile(file, merged, {
    appRoot,
    recorder,
    rootDocuments: [
      {
        file: source.file,
        form: source.form,
        content: source.content,
        digest: source.digest,
        layer: source.context.layer,
        document: source.value,
      },
    ],
    scope: loadScope,
    loadPolicy: source.context.policy,
    logger: source.context.logger,
  }).pipe(
    Effect.catchTag(["LandofileParseError", "LandofileValidationError"], (error) =>
      classifyLoadFailure(error, appRoot, getSourceDocuments(merged)),
    ),
  );
  yield* publishIncludeProposals(session, inputs?.stateStore);
  return { landofile: rememberLandofileAppRoot(landofile, appRoot), scope: loadScope };
});
