import type { AppPlan } from "@lando/sdk/schema";
import { EnvironmentValueResolver, type EnvironmentValueResolverSession } from "@lando/sdk/services";
import { Effect } from "effect";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
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
        yield* request.beforeApply ?? Effect.void;
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
