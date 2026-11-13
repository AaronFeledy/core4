import type { StartAppOptions, StartAppResult } from "@lando/sdk/app";
import type { AppPlan, PreparedFileSyncTarget, ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { Effect } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { withLaunchVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { ensureAppPlacementState } from "../providers/app-placement.ts";
import { type PreparedRuntimeProvider, prepareProvider } from "../providers/prepared.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { claimAppDataIdentity, claimDataIdentityBeforeRetirement } from "./data-identity-claim.ts";
import { reconcileAppDataIdentity } from "./data-identity-reconcile.ts";
import { runAppInitEvents } from "./events.ts";
import { validateDesiredFileSyncEngine } from "./file-sync-acquire.ts";
import { requireSelectableRouter } from "./global-consumer-admission.ts";
import { selectInfoPlan, selectRebuildPlan } from "./service-selection.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import { rotateChangedFileSync } from "./start-file-sync-rotation.ts";
import {
  type StartAppError,
  ensureStartTransactionConsistent,
  launchAdmittedApp,
  preflightStartAppDrain,
} from "./start-internal.ts";
import {
  type PreparedDebuggerOverlay,
  type PreparedStartOverlays,
  prepareDebuggerOverlay,
  prepareStartOverlays,
} from "./start-overlays.ts";
import { preflightStopApp } from "./stop-internal.ts";
import { retireSupersededRealizations, validateSelectedRename } from "./superseded-realizations.ts";
import {
  publishPlacementVolumeTransitionNotices,
  withVolumeTransitionNotices,
} from "./volume-transition-notice.ts";

declare const admitted: unique symbol;

interface AdmittedBase {
  readonly [admitted]: true;
  readonly target: ResolvedAppTarget;
  readonly provider: PreparedRuntimeProvider;
  readonly placement: Effect.Success<ReturnType<typeof ensureAppPlacementState>>;
  /** Services an unfinished accelerated start removed when admission resumed it. */
  readonly removedByResume: ReadonlyArray<string>;
}
export interface AdmittedApp extends AdmittedBase {
  readonly scope: "app";
  readonly overlays: PreparedStartOverlays;
  readonly preparedTargets: readonly PreparedFileSyncTarget[] | undefined;
}
export interface AdmittedServices<Overlays extends PreparedDebuggerOverlay> extends AdmittedBase {
  readonly scope: "services";
  readonly selectedPlan: AppPlan;
  readonly overlays: Overlays;
}
interface StartActivation {
  readonly operation: "start";
  readonly target: ResolvedAppTarget;
}
interface RestartActivation {
  readonly operation: "restart";
  readonly target: ResolvedAppTarget;
  readonly services: ReadonlyArray<ServiceName> | undefined;
  readonly signal: AbortSignal | undefined;
  readonly managed: StartManagedScope | undefined;
}
interface RebuildActivation extends Omit<RestartActivation, "operation"> {
  readonly operation: "rebuild";
}

type AppActivationError = StartAppError;
type AppActivationServices = Effect.Services<ReturnType<typeof launchAdmittedApp>>;
type ActivationBody<A, E, R, Admission> = (admission: Admission) => Effect.Effect<A, E, R>;

export function withAppActivation<A, E, R>(
  request: StartActivation,
  body: ActivationBody<A, E, R, AdmittedApp>,
): Effect.Effect<A, E | AppActivationError, R | AppActivationServices>;
export function withAppActivation<A, E, R>(
  request: RestartActivation,
  body: ActivationBody<A, E, R, AdmittedApp | AdmittedServices<PreparedDebuggerOverlay>>,
): Effect.Effect<A, E | AppActivationError, R | AppActivationServices>;
export function withAppActivation<A, E, R>(
  request: RebuildActivation,
  body: ActivationBody<A, E, R, AdmittedApp | AdmittedServices<PreparedStartOverlays>>,
): Effect.Effect<A, E | AppActivationError, R | AppActivationServices>;
export function withAppActivation<A, E, R>(
  request: StartActivation | RestartActivation | RebuildActivation,
  body:
    | ActivationBody<A, E, R, AdmittedApp>
    | ActivationBody<A, E, R, AdmittedApp | AdmittedServices<PreparedDebuggerOverlay>>
    | ActivationBody<A, E, R, AdmittedApp | AdmittedServices<PreparedStartOverlays>>,
): Effect.Effect<A, E | AppActivationError, R | AppActivationServices> {
  return withVolumeTransitionNotices(
    withAppMutationLock(
      appLockTarget(request.target.plan),
      Effect.gen(function* () {
        const target = yield* reconcileAppDataIdentity(request.target);
        const plan = target.plan;
        yield* requireSelectableRouter(plan);
        yield* validateDesiredFileSyncEngine(plan);
        let scoped = false;
        let selectedPlan = plan;
        switch (request.operation) {
          case "start":
            break;
          case "restart":
            scoped = request.services !== undefined && request.services.length > 0;
            if (scoped) selectedPlan = yield* selectInfoPlan(plan, request.services);
            break;
          case "rebuild":
            selectedPlan = yield* selectRebuildPlan(plan, request.services);
            scoped = request.services !== undefined && request.services.length > 0;
            break;
          default:
            return request satisfies never;
        }
        const placement = yield* ensureAppPlacementState(target.app, plan.provider);
        yield* validateSelectedRename(target, placement.superseded, scoped);
        const registry = yield* RuntimeProviderRegistry;
        const selectedProvider = yield* registry.select(plan);
        const overlays =
          request.operation === "restart" && scoped
            ? yield* prepareDebuggerOverlay(selectedPlan)
            : yield* prepareStartOverlays({ ...target, plan: selectedPlan }, selectedProvider);
        const provider = yield* prepareProvider(selectedProvider);
        if (!scoped) yield* claimDataIdentityBeforeRetirement(target, placement.superseded, provider);
        const retired = yield* retireSupersededRealizations(target, placement.superseded, {
          provider,
          selectedServices: scoped,
        });
        if (request.operation === "start") yield* rotateChangedFileSync(target, provider);
        const stateStore = yield* StateStore;
        return yield* withLaunchVolumeCoordination({
          plan,
          // A halt also tears down the applied plan, so restart and rebuild lock its volumes up front.
          additionalPlans:
            request.operation === "start" || placement.plan === undefined ? [] : [placement.plan],
          provider,
          stateStore,
          body: Effect.fnUntraced(function* () {
            yield* claimAppDataIdentity(target);
            let resumed: StartAppResult | undefined;
            let preparedTargets: readonly PreparedFileSyncTarget[] | undefined;
            switch (request.operation) {
              case "start":
                preparedTargets = yield* preflightStartAppDrain(target);
                break;
              case "restart":
              case "rebuild": {
                const { signal, managed } = request;
                if ((yield* readPendingAcceleratedStart(target.app, plan)) !== null) {
                  resumed = yield* startAppForTarget(
                    signal === undefined ? {} : { signal },
                    target,
                    managed?.resume ?? managed,
                    { beforeStart: managed?.resume?.beforeStart ?? Effect.void },
                  );
                }
                const stopPreflight = yield* preflightStopApp(target);
                yield* preflightStartAppDrain(target, stopPreflight);
                break;
              }
              default:
                return request satisfies never;
            }
            if (!retired) yield* ensureStartTransactionConsistent(target);
            if (resumed === undefined) yield* runAppInitEvents(plan);
            const base = { target, provider, placement, removedByResume: resumed?.servicesRemoved ?? [] };
            // The overloads tie each operation to its overlay type; one body cannot express that pairing.
            const admission = scoped
              ? ({
                  ...base,
                  scope: "services",
                  selectedPlan,
                  overlays,
                } as AdmittedServices<PreparedDebuggerOverlay>)
              : ({ ...base, scope: "app", overlays, preparedTargets } as AdmittedApp);
            return yield* (body as ActivationBody<A, E, R, typeof admission>)(admission);
          }),
        });
      }),
    ),
  );
}

export const startAppForTarget = Effect.fn("AppOperation.startForTarget")(function* (
  options: StartAppOptions | undefined,
  target: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: { readonly beforeStart?: Effect.Effect<void> } = {},
): Effect.fn.Return<StartAppResult, AppActivationError, AppActivationServices> {
  return yield* withAppActivation({ operation: "start", target }, (admission) =>
    Effect.gen(function* () {
      yield* (execution.beforeStart ?? Effect.void).pipe(Effect.uninterruptible);
      yield* publishPlacementVolumeTransitionNotices(admission.placement, admission.target.plan);
      return yield* launchAdmittedApp(admission, options, managed, {
        ...(admission.preparedTargets === undefined ? {} : { preparedTargets: admission.preparedTargets }),
      });
    }),
  );
});
