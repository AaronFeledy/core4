import type { AppPlan } from "@lando/sdk/schema";
import { EnvironmentValueResolver, type EnvironmentValueResolverSession } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import { HostMountPoints, prepareHostMountPoints } from "./host-mount-points.ts";
import { type PreparedCertificates, stampPreparedCertificates } from "./service-certificates.ts";
import { volumeCreationRecorder } from "./volume-initialization.ts";

export interface ActivationApply<E, R> {
  readonly provider: PreparedRuntimeProvider;
  readonly plan: AppPlan;
  readonly certificates: PreparedCertificates;
  readonly reconcile: boolean;
  /** The plan names every service of the app, so the provider records it as the whole applied plan. */
  readonly complete?: boolean;
  readonly recordedPlan?: AppPlan;
  readonly completionPlan?: AppPlan;
  readonly forbidRecreate?: boolean;
  readonly signal?: AbortSignal;
  readonly beforeApply?: Effect.Effect<void, E, R>;
  readonly environment?: EnvironmentValueResolverSession;
}

export const applyActivation = Effect.fn("Activation.apply")(
  <E = never, R = never>(request: ActivationApply<E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const plan = yield* stampPreparedCertificates(request.plan, request.certificates);
        const session = request.environment ?? (yield* (yield* EnvironmentValueResolver).openSession());
        const onVolumeCreated = yield* volumeCreationRecorder(request.provider, plan);
        const hostMountPoints = yield* Effect.serviceOption(HostMountPoints);
        yield* request.beforeApply ?? Effect.void;
        // Provider creation would make a missing directory as the container user, which under a
        // user-namespace mapping is not the host user. Create them as the host user first; a host
        // that injects the service (tests, embedding hosts) supplies its own implementation.
        if (Option.isSome(hostMountPoints)) yield* hostMountPoints.value.prepare(plan);
        else yield* prepareHostMountPoints(plan);
        return yield* request.provider.apply(plan, {
          reconcile: request.reconcile,
          ...(request.complete === undefined ? {} : { complete: request.complete }),
          ...(request.recordedPlan === undefined ? {} : { recordedPlan: request.recordedPlan }),
          ...(request.completionPlan === undefined ? {} : { completionPlan: request.completionPlan }),
          ...(request.forbidRecreate === undefined ? {} : { forbidRecreate: request.forbidRecreate }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          resolveServiceEnvironment: (service) => session.resolveEnvironment(service.environment),
          onVolumeCreated,
        });
      }),
    ),
);
