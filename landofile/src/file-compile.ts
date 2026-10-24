import { Effect } from "effect";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import { LANDOFILE_LAYER_POSITIONS, type PresentLandofileLayer } from "./layers.ts";
import type { LandofileLoadContext } from "./load-context.ts";
import { composePreparedLayers } from "./pipeline/compose.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { classifyLoadFailure } from "./pipeline/legacy.ts";
import { type LandofileLoadScope, buildLandofileLoadScope } from "./pipeline/materialize.ts";
import { getSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { prepareLandofileSource, prepareLandofileValue } from "./source.ts";

export const compileLandofileFile = Effect.fn("Landofile.loadPreparedFile")(function* (
  file: string,
  context?: LandofileLoadContext,
  inputs?: LandofileRuntimeInputs,
  scope?: LandofileLoadScope,
) {
  const source = yield* prepareLandofileSource(file, context, inputs);
  const prepared = yield* prepareLandofileValue(source);
  const appRoot = source.context.appRoot;
  const layer: PresentLandofileLayer = {
    filePath: file,
    basename: ".lando",
    layer: source.context.layer,
    order: LANDOFILE_LAYER_POSITIONS.find((position) => position.layer === source.context.layer)?.order ?? 3,
  };
  const merged = yield* composePreparedLayers([{ layer, landofile: prepared.value }], source.context, inputs);
  const loadScope =
    scope ??
    (yield* buildLandofileLoadScope(
      [{ file, value: merged }],
      source.context.compilationContext?.env,
      source.context.pendingSites,
    ));
  const landofile = yield* finalizeLandofile(file, merged, {
    appRoot,
    scope: loadScope,
    loadPolicy: source.context.policy,
    logger: source.context.logger,
  }).pipe(
    Effect.catchTag(["LandofileParseError", "LandofileValidationError"], (error) =>
      classifyLoadFailure(error, appRoot, getSourceDocuments(merged)),
    ),
  );
  return { landofile: rememberLandofileAppRoot(landofile, appRoot), scope: loadScope };
});
