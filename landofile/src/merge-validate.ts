import { Effect } from "effect";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import type { LandofileFinalizeOverrides } from "./pipeline/finalize-overrides.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { classifyLoadFailure } from "./pipeline/legacy.ts";
import { getSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { composeLandofileRootLayers } from "./root-compile.ts";

export const mergeLandofileRootLayers = Effect.fnUntraced(function* (
  appRoot: string,
  canonicalPath: string,
  inputs?: LandofileRuntimeInputs & { readonly overrides?: LandofileFinalizeOverrides | undefined },
) {
  const { merged, runtime } = yield* composeLandofileRootLayers(appRoot, inputs);
  const landofile = yield* finalizeLandofile(canonicalPath, merged, {
    appRoot,
    overrides: inputs?.overrides,
    pendingSites: runtime.pendingSites,
    env: runtime.compilationContext?.env,
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
