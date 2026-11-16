import type { FileSyncStartError, GpgAgentTransportError } from "@lando/sdk/errors";
import type { AppPlan, ServiceName } from "@lando/sdk/schema";
import type { ApplyResult, RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect } from "effect";

import { inspectAppliedService } from "./service-readiness.ts";

/** The channel every service inspection shares, whatever steps the caller placed before it. */
type InspectionError = Effect.Error<ReturnType<typeof inspectAppliedService>>;
type InspectionServices = Effect.Services<ReturnType<typeof inspectAppliedService>>;

export interface AppliedAndObserved {
  readonly applied: ApplyResult;
  /** Each service's runtime at inspection time, keyed by the requested service name. */
  readonly initial: ReadonlyMap<string, ServiceRuntimeInfo>;
  /** One runtime per requested service, in the order the services were requested. */
  readonly inspected: ReadonlyArray<ServiceRuntimeInfo>;
}

interface ApplyAndObserveInput<E, R, EBefore, RBefore> {
  /** The provider apply, assembled by the operation that owns its activation policy. */
  readonly apply: Effect.Effect<ApplyResult, E, R>;
  /** Runs once the apply succeeded, before the GPG home is prepared (accelerated journal completion). */
  readonly afterApply?: Effect.Effect<void, FileSyncStartError>;
  /** The overlay scope's deferred preparation of a GPG home an applied container may need. */
  readonly prepareGpgHome: Effect.Effect<void, GpgAgentTransportError>;
  /** Runs after GPG-home preparation and before any service is inspected (worker retirement). */
  readonly beforeInspect?: Effect.Effect<void, EBefore, RBefore>;
  readonly provider: RuntimeProviderShape;
  readonly plan: AppPlan;
  readonly services: ReadonlyArray<{ readonly name: ServiceName }>;
}

/**
 * The apply-and-observe tail a whole-app launch and a selected relaunch share: apply the plan, let
 * the caller step in at the two points where its own effects belong, prepare the GPG home, then
 * inspect every service into the initial-runtime map that readiness and the credential check read.
 *
 * The steps stay in one place because a change to what happens between apply and readiness used to
 * have to be made in both operations at once.
 */
export const applyAndObserveServices = <E, R, EBefore = never, RBefore = never>(
  input: ApplyAndObserveInput<E, R, EBefore, RBefore>,
): Effect.Effect<
  AppliedAndObserved,
  E | EBefore | FileSyncStartError | GpgAgentTransportError | InspectionError,
  R | RBefore | InspectionServices
> =>
  input.apply.pipe(
    Effect.tap(() => input.afterApply ?? Effect.void),
    Effect.tap(() => input.prepareGpgHome),
    Effect.tap(() => input.beforeInspect ?? Effect.void),
    Effect.flatMap((applied) =>
      Effect.forEach(input.services, (service) =>
        inspectAppliedService({ provider: input.provider, plan: input.plan, service: service.name }).pipe(
          Effect.map((runtime): readonly [string, ServiceRuntimeInfo] => [String(service.name), runtime]),
        ),
      ).pipe(
        Effect.map((entries) => ({
          applied,
          initial: new Map(entries),
          inspected: entries.map(([, runtime]) => runtime),
        })),
      ),
    ),
  );
