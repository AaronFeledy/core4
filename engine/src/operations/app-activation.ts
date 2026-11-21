import type { StartAppOptions, StartAppResult } from "@lando/sdk/app";
import { MessageInfoEvent } from "@lando/sdk/events";
import type { AppPlan, PreparedFileSyncTarget, ServiceName } from "@lando/sdk/schema";
import { EventService, RouterService, RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { routeUrlRouterError } from "../lifecycle/route-url-bindings.ts";
import { withLaunchVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { ensureAppPlacementState } from "../providers/app-placement.ts";
import { type PreparedRuntimeProvider, prepareProvider } from "../providers/prepared.ts";
import { resolvePendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { digest, recordedStartCommand } from "./accelerated-start-record.ts";
import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { claimAppDataIdentity, claimDataIdentityBeforeRetirement } from "./data-identity-claim.ts";
import { reconcileAppDataIdentity } from "./data-identity-reconcile.ts";
import { runAppInitEvents } from "./events.ts";
import { validateDesiredFileSyncEngine } from "./file-sync-acquire.ts";
import { preflightSelectedStartFileSync } from "./file-sync-plan.ts";
import { requireSelectableRouter } from "./global-consumer-admission.ts";
import { preflightSelectedRelaunch } from "./selected-relaunch.ts";
import { selectRebuildPlan, selectRestartPlan } from "./service-selection.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import { rotateChangedFileSync } from "./start-file-sync-rotation.ts";
import {
  type StartAppError,
  ensureStartTransactionConsistent,
  launchAdmittedApp,
  preflightStartAppDrain,
} from "./start-internal.ts";
import { type PreparedStartOverlays, prepareStartOverlays } from "./start-overlays.ts";
import { launchAdmittedSelectedStart } from "./start-selected.ts";
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
export interface AdmittedServices extends AdmittedBase {
  readonly scope: "services";
  readonly selectedPlan: AppPlan;
  readonly overlays: PreparedStartOverlays;
  /** The current applied plan, read after any resume; restart refuses without one. */
  readonly appliedPlan: AppPlan | undefined;
  readonly preparedTargets: readonly PreparedFileSyncTarget[] | undefined;
}
interface StartActivation {
  readonly operation: "start";
  readonly target: ResolvedAppTarget;
  readonly services: ReadonlyArray<ServiceName> | undefined;
  readonly signal: AbortSignal | undefined;
  readonly managed: StartManagedScope | undefined;
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
  request: StartActivation | RestartActivation | RebuildActivation,
  body: ActivationBody<A, E, R, AdmittedApp | AdmittedServices>,
): Effect.Effect<A, E | AppActivationError, R | AppActivationServices> {
  return withVolumeTransitionNotices(
    withAppMutationLock(
      appLockTarget(request.target.plan),
      Effect.gen(function* () {
        const target = yield* reconcileAppDataIdentity(request.target);
        const plan = target.plan;
        yield* requireSelectableRouter(plan);
        const routeError = routeUrlRouterError(plan, yield* RouterService);
        if (routeError !== undefined) return yield* routeError;
        let scoped = false;
        let selectedPlan = plan;
        switch (request.operation) {
          case "start":
            scoped = request.services !== undefined && request.services.length > 0;
            if (scoped) selectedPlan = yield* selectRebuildPlan(plan, request.services);
            break;
          case "restart":
            scoped = request.services !== undefined && request.services.length > 0;
            if (scoped) selectedPlan = yield* selectRestartPlan(plan, request.services);
            break;
          case "rebuild":
            selectedPlan = yield* selectRebuildPlan(plan, request.services);
            scoped = request.services !== undefined && request.services.length > 0;
            break;
          default:
            return request satisfies never;
        }
        let placement = yield* ensureAppPlacementState(target.app, plan.provider);
        yield* validateSelectedRename(target, placement.superseded, scoped);
        const pending =
          placement.superseded.length === 0 ? yield* resolvePendingAcceleratedStart(target.app, plan) : null;
        const services = scoped ? Object.values(selectedPlan.services).map(({ name }) => name) : undefined;
        let resumed: StartAppResult | undefined;
        const sameAttempt =
          pending !== null &&
          request.operation === "start" &&
          digest(services ?? null) === digest(pending.record.services ?? null);
        if (pending !== null && !sameAttempt) {
          const { signal, managed } = request;
          resumed = yield* startAppForTarget(
            {
              ...(signal === undefined ? {} : { signal }),
              ...(pending.record.services === undefined ? {} : { services: pending.record.services }),
            },
            target,
            managed?.resume ?? managed,
            { beforeStart: managed?.resume?.beforeStart ?? Effect.void },
          );
          placement = yield* ensureAppPlacementState(target.app, plan.provider);
          if (digest(services ?? null) !== digest(pending.record.services ?? null)) {
            const events = yield* EventService;
            yield* events.publish(
              MessageInfoEvent.make({
                body: `Recovered unfinished \`${recordedStartCommand(pending.record)}\` before continuing.`,
                timestamp: DateTime.nowUnsafe(),
              }),
            );
          }
        }
        if (request.operation === "start" && scoped)
          yield* preflightSelectedStartFileSync(selectedPlan, placement.plan);
        yield* validateDesiredFileSyncEngine(request.operation === "start" ? selectedPlan : plan);
        const registry = yield* RuntimeProviderRegistry;
        const selectedProvider = yield* registry.select(plan);
        const overlays = yield* prepareStartOverlays({ ...target, plan: selectedPlan }, selectedProvider);
        const provider = yield* prepareProvider(selectedProvider);
        if (!scoped) yield* claimDataIdentityBeforeRetirement(target, placement.superseded, provider);
        const retired = yield* retireSupersededRealizations(target, placement.superseded, {
          provider,
          selectedServices: scoped,
        });
        if (request.operation === "start" && !scoped) yield* rotateChangedFileSync(target, provider);
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
            let preparedTargets: readonly PreparedFileSyncTarget[] | undefined;
            switch (request.operation) {
              case "start":
                preparedTargets = yield* preflightStartAppDrain(target, undefined, services);
                break;
              case "restart":
              case "rebuild": {
                const stopPreflight = yield* preflightStopApp(target);
                yield* preflightStartAppDrain(target, stopPreflight);
                break;
              }
              default:
                return request satisfies never;
            }
            if (!retired) yield* ensureStartTransactionConsistent(target);
            let appliedPlan: AppPlan | undefined;
            if (scoped) {
              appliedPlan =
                request.operation === "start"
                  ? placement.plan
                  : yield* preflightSelectedRelaunch(target, selectedPlan, request.operation);
            }
            if (resumed === undefined) yield* runAppInitEvents(plan);
            const base = { target, provider, placement, removedByResume: resumed?.servicesRemoved ?? [] };
            const admission = scoped
              ? {
                  ...base,
                  scope: "services" as const,
                  selectedPlan,
                  overlays,
                  appliedPlan,
                  preparedTargets,
                }
              : { ...base, scope: "app" as const, overlays, preparedTargets };
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
  return yield* withAppActivation(
    { operation: "start", target, services: options?.services, signal: options?.signal, managed },
    (admission) =>
      Effect.gen(function* () {
        yield* (execution.beforeStart ?? Effect.void).pipe(Effect.uninterruptible);
        yield* publishPlacementVolumeTransitionNotices(
          admission.placement,
          admission.scope === "services" ? admission.selectedPlan : admission.target.plan,
        );
        const executionTargets =
          admission.preparedTargets === undefined ? {} : { preparedTargets: admission.preparedTargets };
        if (admission.scope === "services") {
          return yield* launchAdmittedSelectedStart(admission, options, managed, executionTargets);
        }
        return yield* launchAdmittedApp(admission, options, managed, {
          ...executionTargets,
          announceApplyOutcome: true,
        });
      }),
  );
});
