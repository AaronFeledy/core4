import type { AppPlan } from "@lando/sdk/schema";
import {
  EnvironmentValueResolver,
  type EnvironmentValueResolverSession,
  StateStore,
} from "@lando/sdk/services";
import { Effect, Option } from "effect";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import { convergeActivationCredentials } from "./activation-credentials.ts";
import { HostMountPoints, prepareHostMountPoints } from "./host-mount-points.ts";
import { type PreparedRouteUrls, lowerRouteUrls } from "./route-url-bindings.ts";
import { recordRouteUrlEvidence } from "./route-url-evidence.ts";
import { type PreparedCertificates, stampPreparedCertificates } from "./service-certificates.ts";
import { withPlanVolumeCoordination } from "./volume-coordination.ts";
import { volumeCreationRecorder } from "./volume-initialization.ts";

export const openDatabaseCredentialSession = Effect.fnUntraced(function* (plan: AppPlan) {
  if (!Object.values(plan.services).some((service) => service.connection !== undefined)) return undefined;
  return yield* (yield* EnvironmentValueResolver).openSession();
});

export interface ActivationApply<E, R> {
  readonly provider: PreparedRuntimeProvider;
  readonly plan: AppPlan;
  readonly certificates: PreparedCertificates;
  readonly routeUrls?: PreparedRouteUrls | undefined;
  readonly reconcile: boolean;
  /** The plan names every service of the app, so the provider records it as the whole applied plan. */
  readonly complete?: boolean;
  readonly recordedPlan?: AppPlan;
  readonly completionPlan?: AppPlan;
  readonly signal?: AbortSignal;
  readonly beforeApply?: Effect.Effect<void, E, R>;
  readonly environment?: EnvironmentValueResolverSession;
  readonly previousPlan?: AppPlan | undefined;
}

export const applyActivation = Effect.fn("Activation.apply")(
  <E = never, R = never>(request: ActivationApply<E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const stamped = yield* stampPreparedCertificates(request.plan, request.certificates);
        const plan = yield* Effect.fromResult(lowerRouteUrls(stamped, request.routeUrls));
        const record = request.recordedPlan ?? (plan === stamped ? undefined : stamped);
        const recordedPlan =
          record === undefined ? undefined : recordRouteUrlEvidence(record, stamped, request.routeUrls);
        const session = request.environment ?? (yield* (yield* EnvironmentValueResolver).openSession());
        const stateStore = yield* StateStore;
        const applied = yield* withPlanVolumeCoordination({
          plan,
          provider: request.provider,
          stateStore,
          cachePolicy: "apply",
          body: Effect.fn("Activation.applyUnderVolumeLocks")(function* ({ verify }) {
            yield* verify;
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
              ...(recordedPlan === undefined ? {} : { recordedPlan }),
              ...(request.completionPlan === undefined ? {} : { completionPlan: request.completionPlan }),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
              resolveServiceEnvironment: (service) => session.resolveEnvironment(service.environment),
              onVolumeCreated,
            });
          }),
        });
        const credentialChanges = yield* convergeActivationCredentials({
          plan,
          provider: request.provider,
          previousPlan: request.previousPlan,
          applied,
          session,
        });
        return { ...applied, ...(credentialChanges.length === 0 ? {} : { credentialChanges }) };
      }),
    ),
);
