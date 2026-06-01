import { Effect, type Scope } from "effect";

import type { AppPlan, LandofileShape } from "@lando/sdk/schema";

export interface ProcessCwdOptions<E> {
  readonly onEnterError: (cause: unknown) => E;
}

export const withProcessCwd = <A, E, R, CwdError>(
  dir: string,
  use: () => Effect.Effect<A, E, R>,
  options: ProcessCwdOptions<CwdError>,
): Effect.Effect<A, E | CwdError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const original = process.cwd();
        process.chdir(dir);
        return original;
      },
      catch: options.onEnterError,
    }),
    () => use(),
    (original) => Effect.sync(() => process.chdir(original)),
  );

export interface RenderedLandofileInput {
  readonly file: string;
  readonly content: string;
  readonly cwd: string;
}

export interface RenderedPlanResult {
  readonly landofile: LandofileShape;
  readonly landofileForPlan: LandofileShape;
  readonly plan: AppPlan;
}

export interface LoadPlanFromRenderedFileInput<
  ReadError,
  DecodeError,
  PlanError,
  CwdError,
  ReadServices,
  DecodeServices,
  PlanServices,
> {
  readonly file: string;
  readonly cwd: string;
  readonly read: Effect.Effect<string, ReadError, ReadServices>;
  readonly decode: (
    input: RenderedLandofileInput,
  ) => Effect.Effect<LandofileShape, DecodeError, DecodeServices>;
  readonly prepareLandofile?: (landofile: LandofileShape) => LandofileShape;
  readonly plan: (landofile: LandofileShape) => Effect.Effect<AppPlan, PlanError, PlanServices>;
  readonly onEnterCwdError: (cause: unknown) => CwdError;
}

export const loadPlanFromRenderedFile = <
  ReadError,
  DecodeError,
  PlanError,
  CwdError,
  ReadServices = never,
  DecodeServices = never,
  PlanServices = never,
>(
  input: LoadPlanFromRenderedFileInput<
    ReadError,
    DecodeError,
    PlanError,
    CwdError,
    ReadServices,
    DecodeServices,
    PlanServices
  >,
): Effect.Effect<
  RenderedPlanResult,
  ReadError | DecodeError | PlanError | CwdError,
  ReadServices | DecodeServices | PlanServices
> =>
  Effect.gen(function* () {
    const content = yield* input.read;
    const landofile = yield* input.decode({ file: input.file, content, cwd: input.cwd });
    const landofileForPlan = input.prepareLandofile?.(landofile) ?? landofile;
    const plan = yield* withProcessCwd(input.cwd, () => input.plan(landofileForPlan), {
      onEnterError: input.onEnterCwdError,
    });
    return { landofile, landofileForPlan, plan };
  });

interface ApplyPlanWithCleanupBase<A, E, R, CleanupServices> {
  readonly apply: Effect.Effect<A, E, R>;
  readonly cleanup?: Effect.Effect<void, never, CleanupServices>;
  readonly cleanupOnError?: boolean;
}

export type ApplyPlanWithCleanupInput<A, E, R, CleanupServices> = ApplyPlanWithCleanupBase<
  A,
  E,
  R,
  CleanupServices
> & {
  readonly registerFinalizer?: boolean;
};

type ScopedServices<R> = Exclude<R, Scope.Scope>;

export function applyPlanWithCleanup<A, E, R = never, CleanupServices = never>(
  input: ApplyPlanWithCleanupBase<A, E, R, CleanupServices> & { readonly registerFinalizer: true },
): Effect.Effect<A, E, ScopedServices<R> | CleanupServices | Scope.Scope>;
export function applyPlanWithCleanup<A, E, R = never, CleanupServices = never>(
  input: ApplyPlanWithCleanupBase<A, E, R, CleanupServices> & { readonly registerFinalizer: boolean },
): Effect.Effect<A, E, ScopedServices<R> | CleanupServices | Scope.Scope>;
export function applyPlanWithCleanup<A, E, R = never, CleanupServices = never>(
  input: ApplyPlanWithCleanupBase<A, E, R, CleanupServices> & { readonly registerFinalizer?: false },
): Effect.Effect<A, E, ScopedServices<R> | CleanupServices>;
export function applyPlanWithCleanup<A, E, R = never, CleanupServices = never>(
  input: ApplyPlanWithCleanupInput<A, E, R, CleanupServices>,
): Effect.Effect<A, E, ScopedServices<R> | CleanupServices | Scope.Scope> {
  return Effect.gen(function* () {
    const scoped = Effect.scoped(input.apply);
    const applied =
      input.cleanup === undefined || input.cleanupOnError === false
        ? scoped
        : scoped.pipe(Effect.tapError(() => input.cleanup ?? Effect.void));
    const result = yield* applied;
    if (input.cleanup !== undefined && input.registerFinalizer === true) {
      yield* Effect.addFinalizer(() => input.cleanup ?? Effect.void);
    }
    return result;
  });
}
