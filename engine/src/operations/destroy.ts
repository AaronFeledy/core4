import type {
  DestroyAppOptions,
  DestroyAppResult,
  DestroyAppError as SdkDestroyAppError,
} from "@lando/sdk/app";
import type {
  ComposeKeyRejectedError,
  FileIoError,
  FileNotFoundError,
  FilePermissionError,
  LandofileLoadExpressionError,
} from "@lando/sdk/errors";
import {
  type AppPlanner,
  type DataMover,
  type EventService,
  type FileSystem,
  type LandofileService,
  type PathsService,
  RuntimeProviderRegistry,
  type StateStore,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Schema } from "effect";
import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  resolveTeardownResolution,
  teardownResolutionAt,
  validateResolvedAppTarget,
} from "./applied-state-target.ts";
import { executeTeardown } from "./destroy-execute.ts";
import { planUserTeardown } from "./destroy-plan.ts";
import { resolveMissingDestroyRoot } from "./destroy-resolution.ts";

export type DestroyAppError = SdkDestroyAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { DestroyAppOptions, DestroyAppResult } from "@lando/sdk/app";

type DestroyAppServices =
  | AppPlanner
  | DataMover
  | EventService
  | LandofileService
  | PathsService
  | PrivateFileAccessService
  | StateStore
  | RuntimeProviderRegistry;
type BoundDestroyAppServices = Exclude<DestroyAppServices, AppPlanner | LandofileService>;

export const DestroyAppResultSchema = Schema.Struct({
  app: Schema.String,
  outcome: Schema.optionalKey(Schema.Literals(["destroyed", "unchanged"])),
  servicesDestroyed: Schema.Array(Schema.String),
  volumesRemoved: Schema.Boolean,
  snapshotsRemoved: Schema.Number,
});

const runTeardown = Effect.fnUntraced(function* <E, R>(
  resolution: TeardownResolution,
  options: DestroyAppOptions,
  request: Parameters<typeof planUserTeardown<E, R>>[2],
) {
  const root = resolution.kind === "applied" ? resolution.target.root : resolution.root;
  const id =
    resolution.kind === "applied"
      ? resolution.target.app.id
      : resolution.kind === "orphans"
        ? resolution.groups[0]?.appId
        : resolution.kind === "owned"
          ? resolution.ownership[0]?.appIds[0]
          : undefined;
  return yield* withAppMutationLock(
    { id: id ?? root, root },
    Effect.gen(function* () {
      if (resolution.kind === "applied" && request.missingRoot !== true)
        yield* validateResolvedAppTarget(resolution.target);
      const plan = yield* planUserTeardown(resolution, options, request);
      return yield* executeTeardown(plan);
    }),
  );
});

export const destroyAppForTarget = Effect.fn("AppOperation.destroyForTarget")(function* (
  options: DestroyAppOptions | undefined,
  target: ResolvedAppTarget,
  afterSuccess?: Effect.Effect<void>,
): Effect.fn.Return<DestroyAppResult, SdkDestroyAppError, BoundDestroyAppServices> {
  return yield* withAppMutationLock(
    target.app,
    Effect.gen(function* () {
      yield* validateResolvedAppTarget(target);
      const registry = yield* RuntimeProviderRegistry;
      const evidence = yield* registry.resolveTeardownEvidence?.(target.root) ?? Effect.succeed(undefined);
      const resolution: TeardownResolution =
        target.landofile === undefined ||
        (registry.resolveAppliedPlan === undefined && registry.resolveTeardownEvidence === undefined)
          ? {
              kind: "applied",
              target,
              ownership:
                evidence === undefined || evidence.kind === "absent" ? [] : (evidence.ownership ?? []),
            }
          : yield* teardownResolutionAt(target.root, true, (plan) =>
              validateResolvedAppTarget({
                plan,
                root: plan.root,
                app: { ...target.app, id: plan.id, root: plan.root },
              }),
            );
      const result = yield* runTeardown(resolution, options ?? {}, { desired: Effect.succeed(target) });
      yield* afterSuccess ?? Effect.void;
      return result;
    }),
  );
});

export const destroyApp = Effect.fn("AppOperation.destroy")(function* (
  options: DestroyAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<DestroyAppResult, DestroyAppError, DestroyAppServices> {
  if (target !== undefined) return yield* destroyAppForTarget(options, target);
  return yield* runTeardown(yield* resolveTeardownResolution, options, { desired: resolveDesiredAppTarget });
});

export const destroyAppAtRoot = Effect.fn("AppOperation.destroyAtRoot")(function* (
  root: string,
  options: DestroyAppOptions = {},
): Effect.fn.Return<
  DestroyAppResult,
  DestroyAppError | FileIoError | FileNotFoundError | FilePermissionError,
  DestroyAppServices | FileSystem
> {
  const { resolution, candidates } = yield* resolveMissingDestroyRoot(root);
  return yield* runTeardown(resolution, options, {
    desired: Effect.succeed(undefined),
    snapshotRoots: candidates,
    missingRoot: true,
  });
});
