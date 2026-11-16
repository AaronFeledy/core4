import { FileSyncStartError, ProviderUnavailableError } from "@lando/sdk/errors";
import { PostServiceStopEvent, PreServiceStopEvent } from "@lando/sdk/events";
import type { AppPlan, FileSyncSessionSpec } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";
import { BuildOrchestrator, EventService, RouterService } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { applyActivation } from "../lifecycle/activation-apply.ts";
import { prepareServiceCertificates } from "../lifecycle/service-certificates.ts";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import { resolveAppPlacement } from "../providers/app-placement.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import type { AdmittedServices } from "./app-activation.ts";
import { publishApplyOutcomeNotices } from "./apply-outcome-notices.ts";
import { collectPlanConnections, startedServices } from "./connection-collector.ts";
import {
  openDatabaseCredentialSession,
  publishDatabaseCredentialWarningsSafely,
} from "./database-credential-warnings.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { sameFileSyncSessionSpec } from "./file-sync-paths.ts";
import { withGlobalConsumerAdmission } from "./global-consumer-admission.ts";
import { verifyGlobalConsumerAdmission } from "./global-consumer-lease.ts";
import { selectedAppliedRecord } from "./selected-relaunch-record.ts";
import { inspectAppliedService } from "./service-readiness.ts";
import type { StartManagedScope } from "./start-file-sync.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import { projectDebuggerOverlay, withAcquiredStartOverlays } from "./start-overlays.ts";

export type SelectedRelaunchOperation = "restart" | "rebuild";

/**
 * Only start prepares and retires accelerated sync targets (it journals, flushes, and populates
 * them before apply), so a selected relaunch refuses any selected service whose accelerated
 * session is new, changed, or removed instead of mounting an empty target or dropping unflushed
 * changes.
 */
const requireUnchangedAcceleratedSessions = Effect.fnUntraced(function* (
  selectedPlan: AppPlan,
  appliedPlan: AppPlan | undefined,
  operation: SelectedRelaunchOperation,
) {
  const bundle = yield* fileSyncBundle(selectedPlan);
  const desired = bundle.kind === "accelerated" ? bundle.sessions : [];
  const applied = (appliedPlan?.fileSync ?? []).flatMap(({ engineId, session }) =>
    Object.hasOwn(selectedPlan.services, session.service) ? [{ engineId, session }] : [],
  );
  const engineId = bundle.kind === "accelerated" ? bundle.id : undefined;
  const matches = (session: FileSyncSessionSpec, entry: (typeof applied)[number]) =>
    entry.engineId === engineId && sameFileSyncSessionSpec(session, entry.session);
  const added = desired.find((session) => !applied.some((entry) => matches(session, entry)));
  const removed = applied.find((entry) => !desired.some((session) => matches(session, entry)));
  const changed = added ?? removed?.session;
  if (changed === undefined) return;
  return yield* Effect.fail(
    new FileSyncStartError({
      engineId: engineId ?? removed?.engineId ?? "unknown",
      sessionSpec: changed,
      message: `${changed.service}'s accelerated file-sync mount is new, changed, or removed, and a selected ${operation} cannot prepare or retire its sync target.`,
      remediation: "Run `lando start`, which prepares and retires sync targets before it recreates services.",
    }),
  );
});

/**
 * Resolves the applied plan a selected relaunch writes against, before init hooks run. Restart
 * requires one; rebuild may run without it. Admission reads placement before an accelerated-start
 * resume, so this reads it again. Placement consults applied plans only: named volumes that a
 * destroy kept are not an applied app, and the remedy for both is `lando start`.
 */
export const preflightSelectedRelaunch = Effect.fnUntraced(function* (
  target: ResolvedAppTarget,
  selectedPlan: AppPlan,
  operation: SelectedRelaunchOperation,
) {
  const appliedPlan = (yield* resolveAppPlacement(target.app, target.plan.provider)).plan;
  if (operation === "restart" && appliedPlan === undefined) {
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: String(target.plan.provider),
        operation: "restart",
        message: `${target.plan.name} has not been started, so it has no services to restart.`,
        remediation: "Run `lando start` to start the app.",
      }),
    );
  }
  yield* requireUnchangedAcceleratedSessions(selectedPlan, appliedPlan, operation);
  return appliedPlan;
});

export interface SelectedRelaunchRequest {
  readonly operation: SelectedRelaunchOperation;
  readonly signal?: AbortSignal;
  readonly managed?: StartManagedScope;
}

export const relaunchSelectedServices = Effect.fnUntraced(function* (
  admitted: AdmittedServices,
  request: SelectedRelaunchRequest,
) {
  const { operation, signal, managed } = request;
  const { selectedPlan, target, provider, overlays: preparedOverlays, appliedPlan } = admitted;
  const builds = yield* BuildOrchestrator;
  const events = yield* EventService;
  const router = yield* RouterService;
  const landofileRouter = target.landofile?.document.router;
  // Prepare before anything stops, so a CA failure leaves the services running.
  const { plan, certificates } = yield* prepareServiceCertificates(selectedPlan);
  yield* markStartMutation(target.plan);
  return yield* withAcquiredStartOverlays({ ...target, plan }, preparedOverlays, {
    provider,
    workerPlan: target.plan,
    reusePolicy: "adopt",
    ...(managed === undefined ? {} : { managed }),
    use: Effect.fnUntraced(function* (applyPlan, prepareGpgHome) {
      // Overlays first, then build, so build keys and cache hits match start.
      const builtPlan = yield* withBuildProvider(
        builds.build(applyPlan, operation === "rebuild" ? { refresh: true } : undefined),
        provider,
      );
      const runtimePlan = projectDebuggerOverlay(builtPlan, preparedOverlays);
      const readinessPlan: AppPlan = {
        ...target.plan,
        services: { ...target.plan.services, ...runtimePlan.services },
      };
      const record = selectedAppliedRecord(target.plan, runtimePlan, appliedPlan);
      const services = Object.values(runtimePlan.services);
      return yield* withGlobalConsumerAdmission(
        {
          plan: readinessPlan,
          setupRouter: true,
          ...(signal === undefined ? {} : { signal }),
          ...(landofileRouter === undefined ? {} : { landofileRouter }),
        },
        Effect.scoped(
          Effect.gen(function* () {
            const environment = yield* openDatabaseCredentialSession(runtimePlan);
            for (const service of [...services].reverse()) {
              if (signal?.aborted === true) return yield* Effect.interrupt;
              yield* events.publish(
                PreServiceStopEvent.make({
                  eventName: "pre-service-stop",
                  appRef: target.app,
                  serviceName: service.name,
                  providerId: target.plan.provider,
                  timestamp: DateTime.nowUnsafe(),
                }),
              );
              // A planned service whose container is already gone needs no stop.
              yield* provider
                .stop({ app: target.plan.id, service: service.name, plan: runtimePlan })
                .pipe(Effect.catchTag("ServiceNotFoundError", () => Effect.void));
              yield* events.publish(
                PostServiceStopEvent.make({
                  eventName: "post-service-stop",
                  appRef: target.app,
                  serviceName: service.name,
                  providerId: target.plan.provider,
                  timestamp: DateTime.nowUnsafe(),
                }),
              );
            }
            if (signal?.aborted === true) return yield* Effect.interrupt;
            const applied = yield* applyActivation({
              provider,
              plan: runtimePlan,
              certificates,
              reconcile: operation === "rebuild",
              recordedPlan: record,
              completionPlan: readinessPlan,
              ...(environment === undefined ? {} : { environment }),
              ...(signal === undefined ? {} : { signal }),
              beforeApply: verifyGlobalConsumerAdmission,
            });
            yield* prepareGpgHome;
            const initial = new Map<string, ServiceRuntimeInfo>();
            for (const service of services) {
              initial.set(
                String(service.name),
                yield* inspectAppliedService({
                  provider,
                  plan: readinessPlan,
                  service: service.name,
                }),
              );
            }
            // Publish before completion so a later readiness failure still reports the replacement.
            if (operation === "restart")
              yield* publishApplyOutcomeNotices(events, applied.services, { created: true });
            const ready = yield* completeStartup({
              policy: "selected",
              selectedPlan: runtimePlan,
              routePlan: record,
              builds,
              router,
              events,
              ...(operation === "rebuild" ? { forceAppBuild: true } : {}),
              provider,
              plan: readinessPlan,
              services: services.map((service) => service.name),
              initial,
              ...(signal === undefined ? {} : { signal }),
              ...(landofileRouter === undefined ? {} : { landofileRouter }),
            });
            if (environment !== undefined) {
              yield* publishDatabaseCredentialWarningsSafely({
                provider,
                plan: runtimePlan,
                services: ready,
                session: environment,
                ...(appliedPlan === undefined ? {} : { previousPlan: appliedPlan }),
              });
            }
            return startedServices(yield* collectPlanConnections(readinessPlan, ready), applied.services);
          }),
        ),
      );
    }),
  });
});
