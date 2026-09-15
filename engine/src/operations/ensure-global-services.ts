import { DateTime, Effect } from "effect";

import type {
  CapabilityError,
  CommandAliasConflictError,
  ConfigExpressionError,
  EventError,
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  GlobalServiceCollisionError,
  HomePathCapabilityError,
  LandofileParseError,
  LandofileUnknownEventError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  PluginManifestError,
  ProviderConfigError,
  ProviderUnavailableError,
  PublicationUnsupportedError,
  RouteInputError,
  SecretNotFoundError,
  ToolingExecError,
} from "@lando/sdk/errors";
import { GlobalServiceMissingError } from "@lando/sdk/errors";
import { PostGlobalStartEvent, PreGlobalStartEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  type AppPlanner,
  BuildOrchestrator,
  EventService,
  type FileSystem,
  type FileSystemError,
  type GlobalAppService,
  type PluginRegistry,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { recordCreatedVolumes } from "../lifecycle/volume-initialization.ts";
import { MANAGED_PROVIDER_SELECT_PLAN } from "../providers/managed.ts";
import { withBuildProvider } from "../services/build-orchestrator.ts";
import { resolveServiceEnvironmentSecrets } from "../services/secret-environment.ts";
import { publishedEndpointUrls } from "./authority-url.ts";

import { globalInstall } from "./global-install.ts";
import { loadGlobalPlan } from "./global-plan.ts";

const now = () => DateTime.unsafeMake(new Date().toISOString());

const globalAppRef = (plan: AppPlan): AppRef => ({ kind: "global", id: plan.id, root: plan.root });

export interface EnsureGlobalServicesOptions {
  readonly services: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}

export interface EnsureGlobalStartedService {
  readonly name: string;
  readonly state: string;
  readonly endpoints: ReadonlyArray<string>;
}

export interface EnsureGlobalServicesResult {
  readonly app: string;
  readonly servicesStarted: ReadonlyArray<EnsureGlobalStartedService>;
}

export type EnsureGlobalServicesError =
  | CommandAliasConflictError
  | HomePathCapabilityError
  | ConfigExpressionError
  | CapabilityError
  | PublicationUnsupportedError
  | EventError
  | FileSystemError
  | GlobalAppError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
  | GlobalServiceMissingError
  | LandofileParseError
  | LandofileUnknownEventError
  | LandofileValidationError
  | RouteInputError
  | NoProviderInstalledError
  | NotImplementedError
  | PluginManifestError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | SecretNotFoundError
  | ToolingExecError;

export type EnsureGlobalServicesServices =
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
): GlobalServiceMissingError =>
  new GlobalServiceMissingError({
    message: `Global service(s) not available in the global app: ${missing.join(", ")}.`,
    requested: [...requested],
    available: [...available],
    remediation: "Run `lando global:install <plugin>` to enable the required global service(s).",
  });

export const ensureGlobalServicesRunning = (
  options: EnsureGlobalServicesOptions,
): Effect.Effect<EnsureGlobalServicesResult, EnsureGlobalServicesError, EnsureGlobalServicesServices> =>
  Effect.gen(function* () {
    const requested = options.services;
    yield* globalInstall({});
    const loaded = yield* loadGlobalPlan();
    const events = yield* EventService;

    if (!loaded.materialized) {
      return yield* Effect.fail(missingServiceError(requested, requested, []));
    }

    const plan = loaded.plan;
    const planServices = Object.values(plan.services);
    const available = planServices.map((service) => String(service.name));
    const availableSet = new Set(available);
    const missing = requested.filter((id) => !availableSet.has(id));

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

    if (missing.length > 0) {
      return yield* Effect.fail(missingServiceError(requested, missing, available));
    }

    const requestedSet = includeAvailableDependencies(requested, planServices);
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

    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(MANAGED_PROVIDER_SELECT_PLAN);
    const builds = yield* BuildOrchestrator;
    const builtPlan = yield* withBuildProvider(builds.build(planToApply), provider);
    const serviceEnvironment = yield* resolveServiceEnvironmentSecrets(builtPlan);

    yield* Effect.scoped(
      provider
        .apply(builtPlan, {
          reconcile: false,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          serviceEnvironment,
        })
        .pipe(Effect.tap((result) => recordCreatedVolumes(provider, builtPlan, result))),
    );

    const servicesStarted = yield* Effect.forEach(selected, (service) =>
      provider.inspect({ app: plan.id, service: service.name, plan }).pipe(
        Effect.map((runtime) => ({
          name: String(service.name),
          state: runtime.state ?? runtime.status,
          endpoints: publishedEndpointUrls(runtime.endpoints ?? service.endpoints),
        })),
      ),
    );

    yield* events.publish(
      PostGlobalStartEvent.make({
        scope: "global",
        app: globalAppRef(plan),
        plan,
        cached: false,
        timestamp: now(),
      }),
    );

    return { app: plan.name, servicesStarted };
  });
