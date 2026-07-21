import { DateTime, Effect } from "effect";

import type {
  CapabilityError,
  EventError,
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  GlobalServiceCollisionError,
  LandofileParseError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  PluginManifestError,
  ProviderConfigError,
  ProviderUnavailableError,
  ToolingExecError,
} from "@lando/sdk/errors";
import { GlobalServiceMissingError } from "@lando/sdk/errors";
import { PostGlobalStartEvent, PreGlobalStartEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef, EndpointPlan } from "@lando/sdk/schema";
import {
  type AppPlanResolver,
  BuildOrchestrator,
  EventService,
  type FileSystem,
  type FileSystemError,
  type GlobalAppService,
  type PluginRegistry,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { withBuildProvider } from "../../../services/build-orchestrator.ts";
import { globalInstall } from "./global-install.ts";
import { type LoadGlobalPlanError, loadGlobalPlan } from "./global-plan.ts";

const now = () => DateTime.unsafeMake(new Date().toISOString());

const globalAppRef = (plan: AppPlan): AppRef => ({ kind: "global", id: plan.id, root: plan.root });

const endpointText = (endpoint: EndpointPlan): string => {
  if (endpoint.socketPath !== undefined) return `${endpoint.protocol}:${endpoint.socketPath}`;
  if (endpoint.port === undefined) return endpoint.protocol;
  return `${endpoint.protocol}://localhost:${endpoint.port}`;
};

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
  | CapabilityError
  | EventError
  | FileSystemError
  | GlobalAppError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
  | GlobalServiceMissingError
  | LandofileParseError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | PluginManifestError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ToolingExecError
  | LoadGlobalPlanError;

export type EnsureGlobalServicesServices =
  | AppPlanResolver
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | PluginRegistry
  | RuntimeProviderRegistry;

export const requiredGlobalServicesForPlan = (plan: Pick<AppPlan, "requires">): ReadonlyArray<string> =>
  plan.requires?.globalServices ?? [];

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

    const requestedSet = new Set(requested);
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
    const provider = yield* registry.select(plan);
    const builds = yield* BuildOrchestrator;
    const builtPlan = yield* withBuildProvider(builds.build(planToApply), provider);

    yield* Effect.scoped(
      provider.apply(builtPlan, {
        reconcile: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );

    const servicesStarted = yield* Effect.forEach(selected, (service) =>
      provider.inspect({ app: plan.id, service: service.name, plan }).pipe(
        Effect.map((runtime) => ({
          name: String(service.name),
          state: runtime.state ?? runtime.status,
          endpoints: (runtime.endpoints ?? service.endpoints).map(endpointText),
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
