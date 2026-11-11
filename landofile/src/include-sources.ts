import { mapFailures } from "@lando/sdk/command-result";
import type { StateStoreShape } from "@lando/sdk/services";
import { type SourceAcquisitionError, type SourceSession, makeSourceStore } from "@lando/source-acquisition";
import { Effect, type Scope } from "effect";
import type { LandofileIncludeDeps, ResolveContext } from "./include-context.ts";
import { missingRuntimeInput } from "./include-context.ts";
import { includeError } from "./include-guard.ts";
import type { IncludeResolutionSession } from "./include-session.ts";
import type { LandofileRuntimePorts } from "./ports.ts";

/** Map private store failures to stable include error tags. */
export const mapSourceAcquisitionError = (error: SourceAcquisitionError) => {
  const kind =
    error.kind === "offline-miss" ||
    error.kind === "not-found" ||
    error.kind === "version-not-found" ||
    error.kind === "invalid-locator"
      ? ("source-unresolved" as const)
      : ("fetch-failed" as const);
  return includeError({
    message: error.message,
    source: error.source,
    kind,
    remediation: error.remediation,
  });
};

export const runSource = <A>(
  effect: Effect.Effect<A, SourceAcquisitionError>,
  signal: AbortSignal,
): Promise<A> => Effect.runPromise(effect.pipe(mapFailures(mapSourceAcquisitionError)), { signal });

export const requiredSourceSession = async (
  ctx: ResolveContext,
  signal: AbortSignal,
): Promise<SourceSession> => {
  if (ctx.sourceSession === undefined) throw missingRuntimeInput("source session");
  if (!ctx.walk.rootRegistered) {
    await runSource(ctx.sourceSession.registerRoot(ctx.lockfilePath), signal);
    ctx.walk.rootRegistered = true;
  }
  return ctx.sourceSession;
};

/** Reuse one lease across layers; the caller's scope keeps it alive through lock publication. */
export const withIncludeSourceSession = Effect.fn("Landofile.withSourceSession")(function* <A, E>(
  input: {
    readonly cacheRoot: string;
    readonly stateStore: StateStoreShape | undefined;
    readonly ports?: LandofileRuntimePorts | undefined;
    readonly deps?: LandofileIncludeDeps | undefined;
    readonly includeSession?: IncludeResolutionSession;
  },
  body: (session: SourceSession | undefined) => Effect.Effect<A, E>,
): Effect.fn.Return<A, E | ReturnType<typeof mapSourceAcquisitionError>, Scope.Scope> {
  if (input.stateStore === undefined) return yield* body(undefined);
  if (input.includeSession?.sourceSession.value !== undefined)
    return yield* body(input.includeSession.sourceSession.value);
  const deps = input.deps ?? {};
  const store = makeSourceStore({
    stateStore: input.stateStore,
    transports: {
      ...input.ports?.sources,
      ...(deps.git === undefined ? {} : { git: deps.git }),
      ...(deps.archive === undefined ? {} : { archive: deps.archive }),
      ...(deps.npmRegistry === undefined ? {} : { npmRegistry: deps.npmRegistry }),
    },
  });
  const session = yield* store.session.pipe(mapFailures(mapSourceAcquisitionError));
  if (input.includeSession !== undefined) input.includeSession.sourceSession.value = session;
  return yield* body(session);
});
