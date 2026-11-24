import type { StartAppOptions } from "@lando/sdk/app";
import { type AppPlan, type PreparedFileSyncTarget, isDownRunStatus } from "@lando/sdk/schema";
import { BuildOrchestrator, EventService, RouterService } from "@lando/sdk/services";
import { Effect } from "effect";
import { routerEnabled } from "../config/router-config.ts";
import { applyActivation, openDatabaseCredentialSession } from "../lifecycle/activation-apply.ts";
import { prepareRouteUrlBindings } from "../lifecycle/route-url-bindings.ts";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import { verifyActiveVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import type { AdmittedServices } from "./app-activation.ts";
import { applyAndObserveServices } from "./apply-observe.ts";
import { publishApplyOutcomeNotices } from "./apply-outcome-notices.ts";
import { collectPlanConnections, observeService, startedServices } from "./connection-collector.ts";
import { withGlobalConsumerAdmission } from "./global-consumer-admission.ts";
import { verifyGlobalConsumerAdmission } from "./global-consumer-lease.ts";
import { prepareAcceleratedStart } from "./prepare-accelerated-start.ts";
import { selectedAppliedRecord } from "./selected-relaunch-record.ts";
import { refuseRetainedRouteConsumers, retainedRouteReferences } from "./selected-route-url-bindings.ts";
import { observeServices } from "./service-observation.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import {
  announceAppLaunch,
  preflightAppLaunch,
  publishAppLaunchComplete,
  scanAppLaunch,
} from "./start-internal.ts";
import { projectDebuggerOverlay, withAcquiredStartOverlays } from "./start-overlays.ts";
import { withApplyProgress } from "./start-progress-phases.ts";

/**
 * Omit `complete` to keep running siblings from being converged away. The provider merges
 * previously applied siblings into the record.
 */
export const launchAdmittedSelectedStart = Effect.fnUntraced(function* (
  admitted: AdmittedServices,
  options: StartAppOptions | undefined,
  managed: StartManagedScope | undefined,
  execution: { readonly preparedTargets?: readonly PreparedFileSyncTarget[] } = {},
) {
  const resolvedOptions = options ?? {};
  const { selectedPlan, target, provider, overlays, appliedPlan } = admitted;
  const serviceNames = Object.values(selectedPlan.services).map(({ name }) => name);
  const { plan, certificates } = yield* preflightAppLaunch(
    { ...target, plan: selectedPlan },
    provider,
    serviceNames,
  );
  yield* announceAppLaunch({ target, plan, options: resolvedOptions, services: serviceNames });
  const builds = yield* BuildOrchestrator;
  const events = yield* EventService;
  const router = yield* RouterService;
  const landofileRouter = target.landofile?.document.router;
  yield* markStartMutation(target.plan);
  return yield* withAcquiredStartOverlays({ ...target, plan }, overlays, {
    provider,
    workerPlan: target.plan,
    reusePolicy: "adopt",
    ...(managed === undefined ? {} : { managed }),
    use: Effect.fnUntraced(function* (applyPlan, prepareGpgHome) {
      const builtPlan = yield* withBuildProvider(builds.build(applyPlan), provider);
      const runtimePlan = projectDebuggerOverlay(builtPlan, overlays);
      const readinessPlan: AppPlan = {
        ...target.plan,
        services: { ...target.plan.services, ...runtimePlan.services },
      };
      const record = selectedAppliedRecord(target.plan, runtimePlan, appliedPlan);
      const services = Object.values(runtimePlan.services);
      return yield* withGlobalConsumerAdmission(
        {
          plan: { ...readinessPlan, routes: record.routes },
          setupRouter: true,
          ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
          ...(landofileRouter === undefined ? {} : { landofileRouter }),
        },
        Effect.scoped(
          Effect.gen(function* () {
            const retained = retainedRouteReferences(appliedPlan, runtimePlan);
            const routeUrls = yield* prepareRouteUrlBindings({
              plan: runtimePlan,
              // A record that disables the router withdraws every route at completion.
              routes: routerEnabled(record) ? record.routes : [],
              router,
              appliedPlan,
              retainedTargets: new Set(retained.map(({ service }) => service)),
            });
            yield* refuseRetainedRouteConsumers({
              retained,
              runtimePlan,
              proof: routeUrls,
              operation: "start",
            });
            const environment = yield* openDatabaseCredentialSession(runtimePlan);
            const { pendingStart } = yield* prepareAcceleratedStart(builtPlan, provider, {
              app: target.app,
              events,
              managed,
              services: serviceNames,
              ...(execution.preparedTargets === undefined
                ? {}
                : { preparedTargets: execution.preparedTargets }),
            });
            if (pendingStart !== undefined) yield* pendingStart.advance("record-sessions");
            const launch = yield* withApplyProgress({
              events,
              plan: runtimePlan,
              services,
              rows: (result) => result.inspected.map((runtime) => observeService(readinessPlan, runtime)),
              work: Effect.gen(function* () {
                yield* verifyActiveVolumeCoordination(provider);
                if (pendingStart !== undefined) yield* pendingStart.advance("record-apply-intent");
                return yield* applyAndObserveServices({
                  apply: applyActivation({
                    routeUrls,
                    provider,
                    plan: runtimePlan,
                    previousPlan: appliedPlan,
                    certificates,
                    reconcile: resolvedOptions.reconcile ?? false,
                    recordedPlan: record,
                    completionPlan: readinessPlan,
                    ...(environment === undefined ? {} : { environment }),
                    ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
                    beforeApply: verifyGlobalConsumerAdmission,
                  }),
                  ...(pendingStart === undefined ? {} : { afterApply: pendingStart.complete }),
                  prepareGpgHome,
                  provider,
                  plan: readinessPlan,
                  services,
                });
              }),
            });
            yield* publishApplyOutcomeNotices(events, launch.applied.services, { created: false });
            const ready = yield* completeStartup({
              policy: "selected-start",
              routeUrls,
              selectedPlan: runtimePlan,
              routePlan: record,
              builds,
              router,
              events,
              provider,
              plan: readinessPlan,
              services: services.map((service) => service.name),
              initial: launch.initial,
              ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
              ...(landofileRouter === undefined ? {} : { landofileRouter }),
            });
            yield* publishAppLaunchComplete({ target, plan, services: serviceNames });
            const servicesStarted = startedServices(
              yield* collectPlanConnections(readinessPlan, ready),
              launch.applied.services,
            );
            // Only a sibling the runtime reports as down counts; running or unanswered ones are omitted.
            const unselected = Object.values(target.plan.services)
              .map(({ name }) => name)
              .filter((name) => !Object.hasOwn(selectedPlan.services, name));
            const [checks, observed] = yield* Effect.all(
              [
                scanAppLaunch(runtimePlan, provider, servicesStarted),
                observeServices(Effect.succeed(provider), target.plan, unselected),
              ],
              { concurrency: 2 },
            );
            const stayedDown = unselected.filter((name) => {
              const status = observed.get(name)?.status;
              return status !== undefined && isDownRunStatus(status);
            });
            return {
              app: target.plan.name,
              servicesStarted,
              ...(launch.applied.credentialChanges === undefined
                ? {}
                : { credentialChanges: launch.applied.credentialChanges }),
              ...(checks === undefined ? {} : { checks }),
              ...(stayedDown.length === 0 ? {} : { servicesStayedDown: stayedDown }),
              ...(admitted.removedByResume.length === 0 ? {} : { servicesRemoved: admitted.removedByResume }),
            };
          }),
        ),
      );
    }),
  });
});
