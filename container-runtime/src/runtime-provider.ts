import { Effect, type Scope, Stream } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppId, AppPlan } from "@lando/sdk/schema";
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
  WaitForExitOptions,
} from "@lando/sdk/services";

import type { ProviderDataPlane } from "./data-plane.ts";
import type { ProviderErrorContext } from "./engine-api.ts";

export interface ResolvedProviderOpsInput {
  readonly ctx: ProviderErrorContext;
  readonly resolvePlan: (app: AppId) => Effect.Effect<AppPlan | undefined>;
  readonly noPlanError: (app: AppId, operation: string) => ProviderError;
  readonly before?: Effect.Effect<void, ProviderError>;
  readonly service: {
    readonly lifecycle: (
      plan: AppPlan,
      target: ServiceSelector,
      action: "start" | "stop" | "restart",
    ) => Effect.Effect<void, ProviderError>;
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
  | "start"
  | "stop"
  | "restart"
  | "waitForExit"
  | "exec"
  | "execStream"
  | "inspect"
  | "run"
  | "runStream"
  | "snapshotVolume"
  | "restoreVolume"
  | "listVolumes"
  | "removeVolume"
  | "copyToService"
  | "copyFromService"
  | "exportArtifact"
  | "importArtifact"
>;

export const makeResolvedProviderOps = (input: ResolvedProviderOpsInput): ResolvedProviderOps => {
  const before = input.before ?? Effect.void;
  const unavailable = (operation: string) =>
    new ProviderUnavailableError({
      providerId: input.ctx.providerId,
      operation,
      message: `Provider data-plane operation ${operation} is unavailable.`,
      remediation: input.ctx.remediation,
    });
  const resolve = <A, E extends ProviderError, R>(
    app: AppId,
    operation: string,
    delegate: (plan: AppPlan) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, ProviderError | E, R> =>
    input
      .resolvePlan(app)
      .pipe(
        Effect.flatMap((plan) =>
          plan === undefined
            ? Effect.fail(input.noPlanError(app, operation))
            : before.pipe(Effect.flatMap(() => delegate(plan))),
        ),
      );
  const resolveTarget = <A, E extends ProviderError, R>(
    target: AppSelector,
    operation: string,
    delegate: (plan: AppPlan) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, ProviderError | E, R> => {
    const directPlan = target.plan;
    return directPlan === undefined
      ? resolve(target.app, operation, delegate)
      : before.pipe(Effect.flatMap(() => delegate(directPlan)));
  };
  const resolveTargetStream = <A, E extends ProviderError, R>(
    target: AppSelector,
    operation: string,
    delegate: (plan: AppPlan) => Stream.Stream<A, E, R>,
  ): Stream.Stream<A, ProviderError | E, R> =>
    Stream.unwrap(resolveTarget(target, operation, (plan) => Effect.succeed(delegate(plan))));
  const requireDataPlane = (operation: string): Effect.Effect<ProviderDataPlane, ProviderUnavailableError> =>
    input.dataPlane === undefined ? Effect.fail(unavailable(operation)) : Effect.succeed(input.dataPlane);

  return {
    start: (target) =>
      resolveTarget(target, "start", (plan) => input.service.lifecycle(plan, target, "start")),
    stop: (target) => resolveTarget(target, "stop", (plan) => input.service.lifecycle(plan, target, "stop")),
    restart: (target) =>
      resolveTarget(target, "restart", (plan) => input.service.lifecycle(plan, target, "restart")),
    waitForExit: (target, options) =>
      resolveTarget(target, "waitForExit", (plan) => input.service.waitForExit(plan, target, options)),
    exec: (target, command) =>
      resolveTarget(target, "exec", (plan) => input.service.exec(plan, target, command)),
    execStream: (target, command) =>
      resolveTargetStream(target, "execStream", (plan) => input.service.execStream(plan, target, command)),
    inspect: (target) => resolveTarget(target, "inspect", (plan) => input.service.inspect(plan, target)),
    run: (spec) =>
      requireDataPlane("run").pipe(
        Effect.flatMap((dataPlane) => before.pipe(Effect.flatMap(() => dataPlane.run(spec)))),
      ),
    runStream: (spec) =>
      Stream.unwrap(
        requireDataPlane("runStream").pipe(
          Effect.flatMap((dataPlane) => before.pipe(Effect.map(() => dataPlane.runStream(spec)))),
        ),
      ),
    snapshotVolume: (spec) =>
      requireDataPlane("snapshotVolume").pipe(
        Effect.flatMap((dataPlane) => before.pipe(Effect.flatMap(() => dataPlane.snapshotVolume(spec)))),
      ),
    restoreVolume: (spec) =>
      requireDataPlane("restoreVolume").pipe(
        Effect.flatMap((dataPlane) => before.pipe(Effect.flatMap(() => dataPlane.restoreVolume(spec)))),
      ),
    listVolumes: (filter) =>
      requireDataPlane("listVolumes").pipe(
        Effect.flatMap((dataPlane) => before.pipe(Effect.flatMap(() => dataPlane.listVolumes(filter)))),
      ),
    removeVolume: (ref) =>
      requireDataPlane("removeVolume").pipe(
        Effect.flatMap((dataPlane) => before.pipe(Effect.flatMap(() => dataPlane.removeVolume(ref)))),
      ),
    copyToService: (target, spec) =>
      requireDataPlane("copyToService").pipe(
        Effect.flatMap((dataPlane) =>
          resolveTarget(target, "copyToService", (plan) =>
            dataPlane.copyToService({ ...target, plan }, spec),
          ),
        ),
      ),
    copyFromService: (target, spec) =>
      Stream.unwrap(
        requireDataPlane("copyFromService").pipe(
          Effect.map((dataPlane) =>
            resolveTargetStream(target, "copyFromService", (plan) =>
              dataPlane.copyFromService({ ...target, plan }, spec),
            ),
          ),
        ),
      ),
    exportArtifact: (ref) =>
      Stream.unwrap(
        requireDataPlane("exportArtifact").pipe(
          Effect.flatMap((dataPlane) => before.pipe(Effect.map(() => dataPlane.exportArtifact(ref)))),
        ),
      ),
    importArtifact: (data) =>
      requireDataPlane("importArtifact").pipe(
        Effect.flatMap((dataPlane) => before.pipe(Effect.flatMap(() => dataPlane.importArtifact(data)))),
      ),
  };
};
