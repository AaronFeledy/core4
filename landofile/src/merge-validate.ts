import { Effect } from "effect";
import { createIncludeResolutionSession, publishIncludeProposals } from "./include-session.ts";
import { ensureConsistentRoot } from "./load-context.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import type { LandofileFinalizeOverrides } from "./pipeline/finalize-overrides.ts";
import { classifyLoadFailure } from "./pipeline/legacy.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { evaluateLandofileRootLayers } from "./root-compile.ts";

export type RootLoadInputs = LandofileRuntimeInputs & {
  readonly overrides?: LandofileFinalizeOverrides | undefined;
};

const finalizeLandofileRootLayers = Effect.fnUntraced(function* (
  evaluated: Effect.Success<ReturnType<typeof evaluateLandofileRootLayers>>,
  canonicalPath: string,
  inputs?: RootLoadInputs,
) {
  const { merged, runtime } = evaluated;
  const appRoot = runtime.appRoot;
  const landofile = yield* finalizeLandofile(canonicalPath, merged, {
    scope: evaluated.scope,
    appRoot,
    rootDocuments: evaluated.rootDocuments,
    recorder: runtime.recorder,
    overrides: inputs?.overrides,
    pendingSites: runtime.pendingSites,
    env: runtime.compilationContext?.env,
    loadPolicy: runtime.policy,
    logger: runtime.logger,
    ...(inputs?.templates.context?.env === undefined ? {} : { env: inputs.templates.context.env }),
  }).pipe(
    Effect.catchTag(["LandofileParseError", "LandofileValidationError"], (error) =>
      classifyLoadFailure(error, appRoot, merged.provenance.documents),
    ),
  );
  return landofile;
});

export const compileLandofileRoot = Effect.fnUntraced(function* (
  appRoot: string,
  canonicalPath: string,
  options?: {
    readonly inputs?: RootLoadInputs;
    readonly selection?: Parameters<typeof evaluateLandofileRootLayers>[1]["selection"];
    readonly pinPublication?: "publish" | "defer";
  },
) {
  const inputs = options?.inputs;
  const session = yield* createIncludeResolutionSession({ appRoot, ...inputs });
  const evaluated = yield* evaluateLandofileRootLayers(appRoot, {
    session,
    ...(inputs === undefined ? {} : { inputs }),
    ...(options?.selection === undefined ? {} : { selection: options.selection }),
  });
  const landofile = yield* finalizeLandofileRootLayers(evaluated, canonicalPath, inputs);
  if (options?.pinPublication !== "defer") yield* publishIncludeProposals(session, inputs?.stateStore);
  return landofile;
}, Effect.scoped);

export const mergeLandofileRootLayers = Effect.fnUntraced(function* (
  appRoot: string,
  canonicalPath: string,
  inputs?: RootLoadInputs,
) {
  yield* ensureConsistentRoot(appRoot, inputs);
  return yield* compileLandofileRoot(appRoot, canonicalPath, inputs === undefined ? undefined : { inputs });
});
