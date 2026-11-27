import { type AppliedStateVersionError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppId, AppPlan, PortablePath, ServiceName } from "@lando/sdk/schema";
import { planDataId } from "@lando/sdk/schema";
import type {
  AppSelector,
  CommandSpec,
  ExecChunk,
  ExecResult,
  ExecTarget,
  ProviderError,
  RuntimeProviderShape,
  ServiceExitResult,
  ServiceRuntimeInfo,
  ServiceSelector,
  VolumeArchiveImportSpec,
  WaitForExitOptions,
} from "@lando/sdk/services";
import { Effect, type Scope, Stream } from "effect";

import type { ProviderDataPlane } from "./data-plane.ts";
import type { ProviderErrorContext } from "./engine-api.ts";

export { readAppEnvironment } from "./app-environment.ts";

export interface ResolvedProviderOpsInput {
  readonly ctx: ProviderErrorContext;
  readonly resolvePlan: (
    app: AppId,
  ) => Effect.Effect<AppPlan | undefined, ProviderUnavailableError | AppliedStateVersionError>;
  readonly beforeMutation?: (
    app: AppId,
  ) => Effect.Effect<void, ProviderUnavailableError | AppliedStateVersionError>;
  readonly noPlanError: (app: AppId, operation: string) => ProviderError;
  readonly before?: (
    operation: ResolvedProviderOperation,
    plan?: AppPlan,
    service?: ServiceName,
  ) => Effect.Effect<void, ProviderError>;
  readonly readAppEnvironment: RuntimeProviderShape["readAppEnvironment"];
  readonly service: {
    readonly restart: (plan: AppPlan, target: ServiceSelector) => Effect.Effect<void, ProviderError>;
    readonly resume?: NonNullable<RuntimeProviderShape["resume"]>;
    readonly suspend?: NonNullable<RuntimeProviderShape["suspend"]>;
    readonly waitForExit: (
      plan: AppPlan,
      target: ServiceSelector,
      options?: WaitForExitOptions,
    ) => Effect.Effect<ServiceExitResult, ProviderError, Scope.Scope>;
    readonly exec: (
      plan: AppPlan,
      target: ExecTarget,
      command: CommandSpec,
    ) => Effect.Effect<ExecResult, ProviderError>;
    readonly execStream: (
      plan: AppPlan,
      target: ExecTarget,
      command: CommandSpec,
    ) => Stream.Stream<ExecChunk, ProviderError, Scope.Scope>;
    readonly inspect: (
      plan: AppPlan,
      target: ServiceSelector,
    ) => Effect.Effect<ServiceRuntimeInfo, ProviderError>;
  };
  readonly dataPlane?: ProviderDataPlane;
}

export type ResolvedProviderOps = Pick<
  RuntimeProviderShape,
  | "restart"
  | "resume"
  | "suspend"
  | "waitForExit"
  | "exec"
  | "readAppEnvironment"
  | "execStream"
  | "inspect"
  | "run"
  | "runStream"
  | "exportVolume"
  | "importVolume"
  | "snapshotVolume"
  | "removeVolumeSnapshot"
  | "listVolumeSnapshots"
  | "restoreVolume"
  | "listVolumes"
  | "locateVolume"
  | "observeVolume"
  | "observeBoundVolume"
  | "adoptVolume"
  | "removeVolume"
  | "copyToService"
  | "copyFromService"
  | "exportArtifact"
  | "importArtifact"
>;
export type ResolvedProviderOperation = keyof ResolvedProviderOps;

export const makeResolvedProviderOps = (input: ResolvedProviderOpsInput): ResolvedProviderOps => {
  const before = (operation: ResolvedProviderOperation, plan?: AppPlan, service?: ServiceName) =>
    input.before?.(operation, plan, service) ?? Effect.void;
  const beforeMutation = (app: AppId) => input.beforeMutation?.(app) ?? Effect.void;
  const unavailable = (operation: string) =>
    new ProviderUnavailableError({
      providerId: input.ctx.providerId,
      operation,
      message: `Provider data-plane operation ${operation} is unavailable.`,
      remediation: input.ctx.remediation,
    });
  const resolveTarget = <A, E extends ProviderError, R>(
    target: AppSelector & { readonly service?: ServiceName },
    operation: ResolvedProviderOperation,
    delegate: (plan: AppPlan) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, ProviderError | E, R> => {
    const observational =
      operation === "inspect" ||
      operation === "waitForExit" ||
      operation === "observeVolume" ||
      operation === "observeBoundVolume";
    const supplied = target.plan;
    const read =
      supplied === undefined || observational || input.beforeMutation === undefined
        ? input.resolvePlan(target.app).pipe(Effect.map((recorded) => supplied ?? recorded))
        : beforeMutation(target.app).pipe(Effect.as(supplied));
    return read.pipe(
      Effect.flatMap((plan) =>
        plan === undefined
          ? Effect.fail(input.noPlanError(target.app, operation))
          : before(operation, plan, target.service).pipe(Effect.flatMap(() => delegate(plan))),
      ),
    );
  };
  const withOptionalPlan = (target: ExecTarget) =>
    input
      .resolvePlan(target.app)
      .pipe(
        Effect.map((plan) =>
          target.plan !== undefined || plan === undefined ? target : { ...target, plan },
        ),
      );
  const resolveTargetStream = <A, E extends ProviderError, R>(
    target: AppSelector,
    operation: ResolvedProviderOperation,
    delegate: (plan: AppPlan) => Stream.Stream<A, E, R>,
  ): Stream.Stream<A, ProviderError | E, R> =>
    Stream.unwrap(resolveTarget(target, operation, (plan) => Effect.succeed(delegate(plan))));
  const requireDataPlane = (operation: string): Effect.Effect<ProviderDataPlane, ProviderUnavailableError> =>
    input.dataPlane === undefined ? Effect.fail(unavailable(operation)) : Effect.succeed(input.dataPlane);
  const resolveRunSpec = (
    spec: Parameters<RuntimeProviderShape["run"]>[0],
    operation: "run" | "runStream",
  ): Effect.Effect<Parameters<RuntimeProviderShape["run"]>[0], ProviderError> => {
    const owner = spec.owner;
    return owner === undefined
      ? before(operation).pipe(Effect.as(spec))
      : resolveTarget(owner, operation, (plan) => Effect.succeed({ ...spec, owner: { ...owner, plan } }));
  };

  const observeVolume = (
    target: ServiceSelector,
    destination: PortablePath,
    expectedContainerId?: string,
  ) => {
    const operation = expectedContainerId === undefined ? "observeVolume" : "observeBoundVolume";
    return resolveTarget(
      target,
      operation,
      Effect.fnUntraced(function* (plan) {
        const runtime = yield* input.service.inspect(plan, target);
        if (
          !runtime.containerId ||
          (expectedContainerId !== undefined && runtime.containerId !== expectedContainerId)
        )
          return yield* unavailable(operation);
        const dataPlane = yield* requireDataPlane(operation);
        return yield* dataPlane.observeVolume({
          app: planDataId(plan),
          containerId: runtime.containerId,
          destination,
        });
      }),
    );
  };
  return {
    readAppEnvironment: input.readAppEnvironment,
    restart: Effect.fn("RuntimeProvider.restart")(function* (target) {
      return yield* resolveTarget(target, "restart", (plan) => input.service.restart(plan, target));
    }),
    resume: Effect.fn("RuntimeProvider.resume")(function* (target, identity) {
      return yield* resolveTarget(target, "resume", () => {
        const resume = input.service.resume;
        return resume === undefined ? Effect.fail(unavailable("resume")) : resume(target, identity);
      });
    }),
    suspend: Effect.fn("RuntimeProvider.suspend")(function* (target, identity) {
      return yield* resolveTarget(target, "suspend", () => {
        const suspend = input.service.suspend;
        return suspend === undefined ? Effect.fail(unavailable("suspend")) : suspend(target, identity);
      });
    }),
    waitForExit: Effect.fn("RuntimeProvider.waitForExit")(function* (target, options) {
      return yield* resolveTarget(target, "waitForExit", (plan) =>
        input.service.waitForExit(plan, target, options),
      );
    }),
    exec: Effect.fn("RuntimeProvider.exec")(function* (target, command) {
      return yield* resolveTarget(target, "exec", (plan) => input.service.exec(plan, target, command));
    }),
    execStream: (target, command) =>
      resolveTargetStream(target, "execStream", (plan) => input.service.execStream(plan, target, command)),
    inspect: Effect.fn("RuntimeProvider.inspect")(function* (target) {
      return yield* resolveTarget(target, "inspect", (plan) => input.service.inspect(plan, target));
    }),
    locateVolume: (ref) =>
      requireDataPlane("locateVolume").pipe(
        Effect.flatMap((dataPlane) =>
          before("locateVolume").pipe(Effect.flatMap(() => dataPlane.locateVolume(ref))),
        ),
      ),
    observeVolume: (target, destination) => observeVolume(target, destination),
    ...(input.dataPlane === undefined
      ? {}
      : {
          observeBoundVolume: (target, destination) =>
            observeVolume(target, destination, target.expectedContainerId),
        }),
    adoptVolume: (target, destination) =>
      resolveTarget(
        target,
        "adoptVolume",
        Effect.fn("RuntimeProvider.adoptVolume")(function* (plan) {
          if (!plan.identity) return yield* Effect.fail(unavailable("adoptVolume"));
          const runtime = yield* input.service.inspect(plan, target);
          if (!runtime.containerId) return yield* Effect.fail(unavailable("adoptVolume"));
          const dataPlane = yield* requireDataPlane("adoptVolume");
          return yield* dataPlane.adoptVolume({
            app: planDataId(plan),
            containerId: runtime.containerId,
            destination,
            ownerRoot: plan.identity.appRoot,
          });
        }),
      ),
    run: (spec) =>
      requireDataPlane("run").pipe(
        Effect.flatMap((dataPlane) => resolveRunSpec(spec, "run").pipe(Effect.flatMap(dataPlane.run))),
      ),
    runStream: (spec) =>
      Stream.unwrap(
        requireDataPlane("runStream").pipe(
          Effect.flatMap((dataPlane) =>
            resolveRunSpec(spec, "runStream").pipe(Effect.map(dataPlane.runStream)),
          ),
        ),
      ),
    exportVolume: (ref) =>
      Stream.unwrap(
        requireDataPlane("exportVolume").pipe(
          Effect.flatMap((dataPlane) =>
            before("exportVolume").pipe(Effect.map(() => dataPlane.exportVolume(ref))),
          ),
        ),
      ),
    importVolume: <E, R>(spec: VolumeArchiveImportSpec<E, R>) =>
      requireDataPlane("importVolume").pipe(
        Effect.flatMap((dataPlane) =>
          beforeMutation(spec.target.app).pipe(
            Effect.andThen(before("importVolume")),
            Effect.flatMap(() => dataPlane.importVolume(spec)),
          ),
        ),
      ),
    snapshotVolume: (spec) =>
      requireDataPlane("snapshotVolume").pipe(
        Effect.flatMap((dataPlane) =>
          beforeMutation(spec.volume.app).pipe(
            Effect.andThen(before("snapshotVolume")),
            Effect.flatMap(() => dataPlane.snapshotVolume(spec)),
          ),
        ),
      ),
    removeVolumeSnapshot: (snapshot, options) =>
      requireDataPlane("removeVolumeSnapshot").pipe(
        Effect.flatMap((dataPlane) =>
          (options?.startRuntime === false ? Effect.void : before("removeVolumeSnapshot")).pipe(
            Effect.flatMap(() => dataPlane.removeVolumeSnapshot(snapshot, options)),
          ),
        ),
      ),
    listVolumeSnapshots: () =>
      requireDataPlane("listVolumeSnapshots").pipe(
        Effect.flatMap((dataPlane) => dataPlane.listVolumeSnapshots()),
      ),
    restoreVolume: <E = never>(
      spec: Parameters<RuntimeProviderShape["restoreVolume"]>[0],
      options?: { readonly beforeCommit?: Effect.Effect<void, E> },
    ) =>
      requireDataPlane("restoreVolume").pipe(
        Effect.flatMap((dataPlane) =>
          beforeMutation(spec.target.app).pipe(
            Effect.andThen(before("restoreVolume")),
            Effect.flatMap(() => dataPlane.restoreVolume(spec, options)),
          ),
        ),
      ),
    listVolumes: (filter) =>
      requireDataPlane("listVolumes").pipe(
        Effect.flatMap((dataPlane) =>
          before("listVolumes").pipe(Effect.flatMap(() => dataPlane.listVolumes(filter))),
        ),
      ),
    removeVolume: (ref, expectedGeneration) =>
      requireDataPlane("removeVolume").pipe(
        Effect.flatMap((dataPlane) =>
          beforeMutation(ref.app).pipe(
            Effect.andThen(before("removeVolume")),
            Effect.flatMap(() => dataPlane.removeVolume(ref, expectedGeneration)),
          ),
        ),
      ),
    copyToService: (target, spec) =>
      requireDataPlane("copyToService").pipe(
        Effect.flatMap((dataPlane) =>
          beforeMutation(target.app).pipe(
            Effect.andThen(withOptionalPlan(target)),
            Effect.flatMap((resolved) =>
              before("copyToService", resolved.plan).pipe(
                Effect.flatMap(() => dataPlane.copyToService(resolved, spec)),
              ),
            ),
          ),
        ),
      ),
    copyFromService: (target, spec) =>
      Stream.unwrap(
        requireDataPlane("copyFromService").pipe(
          Effect.flatMap((dataPlane) =>
            withOptionalPlan(target).pipe(
              Effect.flatMap((resolved) =>
                before("copyFromService", resolved.plan).pipe(
                  Effect.map(() => dataPlane.copyFromService(resolved, spec)),
                ),
              ),
            ),
          ),
        ),
      ),
    exportArtifact: (ref) =>
      Stream.unwrap(
        requireDataPlane("exportArtifact").pipe(
          Effect.flatMap((dataPlane) =>
            before("exportArtifact").pipe(Effect.map(() => dataPlane.exportArtifact(ref))),
          ),
        ),
      ),
    importArtifact: (data) =>
      requireDataPlane("importArtifact").pipe(
        Effect.flatMap((dataPlane) =>
          before("importArtifact").pipe(Effect.flatMap(() => dataPlane.importArtifact(data))),
        ),
      ),
  };
};
