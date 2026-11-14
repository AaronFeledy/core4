import type {
  DebuggerHostUnavailableError,
  EnvironmentValueResolutionError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  GlobalServiceCollisionError,
  PlanReplanRequiredError,
  PluginManifestError,
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
  ServiceNotReadyError,
  ToolingExecError,
} from "@lando/sdk/errors";
import { GlobalServiceMissingError } from "@lando/sdk/errors";
import { PostGlobalStartEvent, PreGlobalStartEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef, StartedService } from "@lando/sdk/schema";
import type { EnvironmentValueResolver } from "@lando/sdk/services";
import {
  type AppPlanner,
  type BuildError,
  BuildOrchestrator,
  EventService,
  type FileSystem,
  GlobalAppService,
  type PluginRegistry,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { DateTime, Effect, Exit } from "effect";
import {
  captureGlobalEnsureInputs,
  forgetGlobalEnsure,
  globalEnsureChanged,
  globalEnsureRecord,
  observeWarmGlobalServices,
  rememberGlobalEnsure,
} from "../global-app/ensure-cache.ts";
import { type GlobalMutationServices, withGlobalMutation } from "../global-app/mutation.ts";
import { globalCreateProviderId } from "../global-app/placement.ts";
import { type GlobalResolution, readGlobalResolution } from "../global-app/resolution.ts";
import { captureGlobalStartupAdmission } from "../global-app/startup-admission.ts";
import { applyActivation } from "../lifecycle/activation-apply.ts";
import { prepareServiceCertificates } from "../lifecycle/service-certificates.ts";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { debuggerHostConfigured } from "../subsystems/debugger-host.ts";
import { interruptOnAbort } from "../subsystems/healthcheck/attempt.ts";
import { prepareDebuggerOverlay, projectDebuggerOverlay } from "../subsystems/start-overlay-registry.ts";
import { canonicalAppRoot } from "./app-mutation-lock.ts";
import { collectPlanConnections, startedServices } from "./connection-collector.ts";

import { withOrdinaryMounts } from "./file-sync-plan.ts";
import { withGlobalConsumerReservation } from "./global-consumer-lease.ts";
import { type globalInstall, installAndLoadGlobalPlan } from "./global-install.ts";
import type { LoadGlobalPlanError } from "./global-plan.ts";
import { advanceGlobalRecordedPlan, reconcileGlobalSiblings } from "./global-retained-plan.ts";

const now = () => DateTime.nowUnsafe();

const globalAppRef = (plan: AppPlan): AppRef => ({ kind: "global", id: plan.id, root: plan.root });

export interface EnsureGlobalServicesOptions {
  readonly services: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}

export type EnsureGlobalStartedService = StartedService;

export interface EnsureGlobalServicesResult {
  readonly app: string;
  readonly servicesStarted: ReadonlyArray<EnsureGlobalStartedService>;
}

export type EnsureGlobalServicesError =
  | import("@lando/sdk/errors").CaError
  | DebuggerHostUnavailableError
  | Effect.Error<ReturnType<typeof globalInstall>>
  | Effect.Error<ReturnType<typeof canonicalAppRoot>>
  | Effect.Error<ReturnType<typeof reconcileGlobalSiblings>>
  | EnvironmentValueResolutionError
  | PlanReplanRequiredError
  | ServiceNotReadyError
  | LoadGlobalPlanError
  | BuildError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
  | GlobalServiceMissingError
  | PluginManifestError
  | SecretNotFoundError
  | SecretStoreUnavailableError
  | SecretReferenceInvalidError
  | ToolingExecError;

export type EnsureGlobalServicesServices =
  | GlobalMutationServices
  | import("@lando/sdk/services").StateStore
  | EnvironmentValueResolver
  | AppPlanner
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | PluginRegistry
  | RuntimeProviderRegistry;

export const requiredGlobalServicesForPlan = (plan: Pick<AppPlan, "requires">): ReadonlyArray<string> =>
  plan.requires?.globalServices ?? [];

export const includeAvailableDependencies = (
  requested: Iterable<string>,
  services: ReadonlyArray<{
    readonly name: unknown;
    readonly dependsOn: ReadonlyArray<{ readonly service: unknown }>;
  }>,
): Set<string> => {
  const byName = new Map(services.map((service) => [String(service.name), service]));
  const selected = new Set(requested);
  for (const name of selected) {
    for (const dependency of byName.get(name)?.dependsOn ?? []) {
      const dependencyName = String(dependency.service);
      if (byName.has(dependencyName)) selected.add(dependencyName);
    }
  }
  return selected;
};

const missingServiceError = (
  requested: ReadonlyArray<string>,
  missing: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
  resolution?: GlobalResolution,
): GlobalServiceMissingError =>
  new GlobalServiceMissingError({
    message: `Global service(s) not available in the global app: ${missing.join(", ")}.`,
    requested: [...requested],
    available: [...available],
    remediation: missing
      .map((id) => {
        const row = resolution?.entries.find((entry) => entry.id === id);
        if (row?.state === "disabled") return `Run \`lando global:enable ${id}\` to enable ${id}.`;
        if (row?.state === "blocked" || row?.state === "unverified")
          return `${id}: ${row.reasons.join(", ")}. Run \`lando global:list\` and repair its provider capability or dependency requirements.`;
        return `Install the plugin that contributes ${id}, then run \`lando global:list\`.`;
      })
      .join(" "),
  });

export const ensureGlobalServicesRunning = Effect.fnUntraced(
  function* (
    options: EnsureGlobalServicesOptions,
  ): Effect.fn.Return<EnsureGlobalServicesResult, EnsureGlobalServicesError, EnsureGlobalServicesServices> {
    const requested = options.services;
    const registry = yield* RuntimeProviderRegistry;
    const globalApp = yield* GlobalAppService;
    const root = yield* canonicalAppRoot((yield* globalApp.paths).root);
    const cached = globalEnsureRecord(registry, root);
    if (cached !== undefined) {
      yield* registry.assertAppliedStateReadable?.({ id: cached.plan.id, provider: cached.plan.provider }) ??
        Effect.void;
      const provider = yield* registry.select(yield* globalCreateProviderId());
      const inputs = yield* captureGlobalEnsureInputs(cached.plan, cached.landofile, provider);
      const names = Object.values(cached.plan.services);
      const selected = includeAvailableDependencies(requested, names);
      const known = requested.every((name) => Object.hasOwn(cached.plan.services, name));
      const services = names
        .filter((service) => selected.has(String(service.name)))
        .map((service) => service.name);
      // A configured debugger address is resolved per start, so its consumers take the cold path.
      const debuggerAddressRequired = yield* debuggerHostConfigured({
        ...cached.plan,
        services: Object.fromEntries(
          Object.entries(cached.plan.services).filter(([, service]) => selected.has(String(service.name))),
        ),
      });
      const observed =
        known && inputs?.digest === cached.inputs.digest && !debuggerAddressRequired
          ? yield* observeWarmGlobalServices(cached, provider, services)
          : undefined;
      if (observed !== undefined) {
        return yield* Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(
            PreGlobalStartEvent.make({
              scope: "global",
              app: globalAppRef(cached.plan),
              plan: cached.plan,
              triggeredBy: "ensure-running",
              ensuringServices: [...requested],
              cached: true,
              timestamp: now(),
            }),
          );
          const afterHook = yield* captureGlobalEnsureInputs(cached.plan, cached.landofile, provider);
          if (afterHook?.digest !== cached.inputs.digest) return yield* Effect.fail(globalEnsureChanged());
          const ready = yield* completeStartup({
            policy: "ensure-global",
            provider,
            plan: cached.plan,
            services,
            initial: observed,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          const afterReadiness = yield* captureGlobalEnsureInputs(cached.plan, cached.landofile, provider);
          if (afterReadiness?.digest !== cached.inputs.digest)
            return yield* Effect.fail(globalEnsureChanged());
          const servicesStarted = startedServices(yield* collectPlanConnections(cached.plan, ready));
          yield* events.publish(
            PostGlobalStartEvent.make({
              scope: "global",
              app: globalAppRef(cached.plan),
              plan: cached.plan,
              cached: true,
              timestamp: now(),
            }),
          );
          return { app: cached.plan.name, servicesStarted };
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Effect.sync(() => forgetGlobalEnsure(registry, root)) : Effect.void,
          ),
        );
      }
      forgetGlobalEnsure(registry, root);
    }
    const loaded = yield* installAndLoadGlobalPlan({ services: requested });
    const events = yield* EventService;

    const plan = loaded.plan;
    const planServices = Object.values(plan.services);
    const available = planServices.map((service) => String(service.name));
    const availableSet = new Set(available);
    const missing = requested.filter((id) => !availableSet.has(id));
    const verifyAdmission = yield* captureGlobalStartupAdmission();

    yield* events.publish(
      PreGlobalStartEvent.make({
        scope: "global",
        app: globalAppRef(plan),
        plan,
        triggeredBy: "ensure-running",
        ensuringServices: [...requested],
        cached: false,
        timestamp: now(),
      }),
    );

    yield* verifyAdmission;
    if (missing.length > 0) {
      const resolution = yield* readGlobalResolution({
        providerId: plan.provider,
        providerCapabilities: (yield* registry.select(plan.provider)).capabilities,
      });
      return yield* Effect.fail(missingServiceError(requested, missing, available, resolution));
    }

    const retained = yield* reconcileGlobalSiblings(plan, yield* registry.select(plan.provider), {
      selectedIds: requested,
      close: (ids) => includeAvailableDependencies(ids, planServices),
    });
    const requestedSet = new Set(retained.selectedIds);
    const selected = planServices.filter((service) => requestedSet.has(String(service.name)));
    const planToApply =
      selected.length === planServices.length
        ? plan
        : {
            ...plan,
            services: Object.fromEntries(
              Object.entries(plan.services).filter(([, service]) => requestedSet.has(String(service.name))),
            ),
          };

    const provider = retained.provider;
    const beforeStartup = yield* captureGlobalEnsureInputs(plan, loaded.landofile, provider);
    const builds = yield* BuildOrchestrator;
    // Managed global service configuration is generated locally and has no sync session lifecycle.
    const { plan: realizedPlan, certificates } = yield* prepareServiceCertificates(
      withOrdinaryMounts(planToApply),
    );
    const preparedOverlays = yield* prepareDebuggerOverlay(realizedPlan);
    const builtPlan = yield* withBuildProvider(builds.build(realizedPlan), provider);
    const runtimePlan = projectDebuggerOverlay(builtPlan, preparedOverlays);

    yield* verifyAdmission;
    const removalIds = retained.removals.map(({ observation }) => String(observation.service));
    const finalPlan = yield* advanceGlobalRecordedPlan(
      retained.recordedPlan,
      builtPlan,
      retained.disabledIds,
      new Set(removalIds),
    );
    // Historical siblings remain observation evidence, never warm admission inputs.
    const desiredFinalPlan = { ...plan, services: { ...plan.services, ...builtPlan.services } };
    yield* withGlobalConsumerReservation(
      builtPlan,
      Object.keys(builtPlan.services),
      applyActivation({
        provider,
        plan: runtimePlan,
        certificates,
        reconcile: false,
        recordedPlan: finalPlan,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        beforeApply: Effect.gen(function* () {
          yield* verifyAdmission;
          for (const removal of retained.removals) yield* provider.removeObservedService(removal.observation);
        }),
      }),
      [...retained.joinedIds, ...removalIds],
    );

    const ready = yield* completeStartup({
      policy: "ensure-global",
      provider,
      plan: finalPlan,
      services: selected.map((service) => service.name),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const servicesStarted = startedServices(yield* collectPlanConnections(finalPlan, ready));
    yield* verifyAdmission;

    yield* events.publish(
      PostGlobalStartEvent.make({
        scope: "global",
        app: globalAppRef(plan),
        plan: realizedPlan,
        cached: false,
        timestamp: now(),
      }),
    );

    const afterStartup = yield* captureGlobalEnsureInputs(desiredFinalPlan, loaded.landofile, provider);
    if (beforeStartup !== undefined && afterStartup?.digest === beforeStartup.digest)
      rememberGlobalEnsure(registry, desiredFinalPlan, loaded.landofile, afterStartup, ready);
    return { app: plan.name, servicesStarted };
  },
  (effect, options: EnsureGlobalServicesOptions) =>
    interruptOnAbort(withGlobalMutation(effect), options.signal),
);
