import { Effect } from "effect";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import { publishIncludeProposals } from "./include-session.ts";
import type { LandofileFinalizeOverrides } from "./pipeline/finalize-overrides.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { classifyLoadFailure } from "./pipeline/legacy.ts";
import { getSourceDocuments } from "./pipeline/source-table.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { composeLandofileRootLayers } from "./root-compile.ts";

export const finalizeLandofileRootLayers = Effect.fnUntraced(function* (
  evaluated: Effect.Success<ReturnType<typeof composeLandofileRootLayers>>,
  canonicalPath: string,
  inputs?: LandofileRuntimeInputs & { readonly overrides?: LandofileFinalizeOverrides | undefined },
) {
  const { merged, runtime, session } = evaluated;
  const appRoot = runtime.appRoot;
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
  yield* publishIncludeProposals(session, inputs?.stateStore);
  return rememberLandofileAppRoot(landofile, appRoot);
});

export const mergeLandofileRootLayers = Effect.fnUntraced(function* (
  appRoot: string,
  canonicalPath: string,
  inputs?: LandofileRuntimeInputs & { readonly overrides?: LandofileFinalizeOverrides | undefined },
) {
  const evaluated = yield* composeLandofileRootLayers(appRoot, inputs);
  return yield* finalizeLandofileRootLayers(evaluated, canonicalPath, inputs);
});
