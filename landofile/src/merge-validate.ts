import { Effect } from "effect";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { classifyLoadFailure } from "./pipeline/legacy.ts";
import { getSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { composeLandofileRootLayers } from "./root-compile.ts";

export const mergeLandofileRootLayers = Effect.fnUntraced(function* (
  appRoot: string,
  canonicalPath: string,
  inputs?: LandofileRuntimeInputs,
) {
  const { merged, runtime } = yield* composeLandofileRootLayers(appRoot, inputs);
  const landofile = yield* finalizeLandofile(canonicalPath, merged, {
    appRoot,
    loadPolicy: runtime.policy,
    logger: runtime.logger,
    ...(inputs?.templates.context?.env === undefined ? {} : { env: inputs.templates.context.env }),
  }).pipe(
    Effect.catchTag(["LandofileParseError", "LandofileValidationError"], (error) =>
      classifyLoadFailure(error, appRoot, getSourceDocuments(merged)),
    ),
  );
  return rememberLandofileAppRoot(landofile, appRoot);
});
