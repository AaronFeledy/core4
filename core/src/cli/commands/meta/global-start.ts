import { DateTime, Effect, Schema } from "effect";

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
} from "@lando/sdk/errors";
import { ToolingExecError } from "@lando/sdk/errors";
import { PostGlobalStartEvent, PreGlobalStartEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef, ServicePlan } from "@lando/sdk/schema";
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
import { hostEndpointText } from "../../authority-url.ts";
import { globalInstall } from "./global-install.ts";
import { type LoadGlobalPlanError, loadGlobalPlan } from "./global-plan.ts";

const now = () => DateTime.unsafeMake(new Date().toISOString());

const globalAppRef = (plan: AppPlan): AppRef => ({ kind: "global", id: plan.id, root: plan.root });

export interface GlobalStartOptions {
  readonly services?: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}

export interface GlobalStartedService {
  readonly name: string;
  readonly state: string;
  readonly endpoints: ReadonlyArray<string>;
}

export interface GlobalStartResult {
  readonly app: string;
  readonly servicesStarted: ReadonlyArray<GlobalStartedService>;
}

export const GlobalStartedServiceSchema = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  endpoints: Schema.Array(Schema.String),
});

export const GlobalStartResultSchema = Schema.Struct({
  app: Schema.String,
  servicesStarted: Schema.Array(GlobalStartedServiceSchema),
});

export type GlobalStartError =
  | CapabilityError
  | EventError
  | FileSystemError
  | GlobalAppError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
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

export type GlobalStartServices =
  | AppPlanResolver
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | PluginRegistry
  | RuntimeProviderRegistry;

const availableServiceList = (services: AppPlan["services"]): string =>
  Object.values(services)
    .map((service) => String(service.name))
    .sort()
    .join(", ");

const unknownServiceError = (requested: string, services: AppPlan["services"]): ToolingExecError => {
  const list = availableServiceList(services);
  return new ToolingExecError({
    message:
      list.length === 0
        ? `meta:global:start: service ${requested} is not in the global app plan.`
        : `meta:global:start: service ${requested} is not in the global app plan (available: ${list}).`,
    tool: "meta:global:start",
  });
};

const selectedServices = (
  plan: AppPlan,
  requested: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<ServicePlan>, ToolingExecError> => {
  const services = Object.values(plan.services);
  if (requested === undefined || requested.length === 0) return Effect.succeed(services);

  const ids = new Set(requested);
  const matched = services.filter((service) => ids.has(String(service.name)));
  const matchedIds = new Set(matched.map((service) => String(service.name)));
  const missing = [...ids].find((service) => !matchedIds.has(service));

  if (missing !== undefined) return Effect.fail(unknownServiceError(missing, plan.services));
  return Effect.succeed(matched);
};

const READY_STATES = new Set(["running", "ready"]);

const isGlobalStartReady = (result: GlobalStartResult): boolean =>
  result.servicesStarted.length > 0 &&
  result.servicesStarted.every((service) => READY_STATES.has(service.state));

export const renderGlobalStartResult = (result: GlobalStartResult): string => {
  const services = result.servicesStarted
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  const prefix = isGlobalStartReady(result) ? "ready" : "starting";
  return `${prefix}: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};

export const globalStart = (
  options: GlobalStartOptions = {},
): Effect.Effect<GlobalStartResult, GlobalStartError, GlobalStartServices> =>
  Effect.gen(function* () {
    yield* globalInstall({});
    const loaded = yield* loadGlobalPlan();
    if (!loaded.materialized) return { app: "global", servicesStarted: [] };

    const services = yield* selectedServices(loaded.plan, options.services);
    const builds = yield* BuildOrchestrator;
    const events = yield* EventService;
    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(loaded.plan);

    // With `--service`, start only the selected subset rather than the whole plan.
    const selectedNames = new Set(services.map((service) => String(service.name)));
    const planToApply =
      services.length === Object.keys(loaded.plan.services).length
        ? loaded.plan
        : {
            ...loaded.plan,
            services: Object.fromEntries(
              Object.entries(loaded.plan.services).filter(([, service]) =>
                selectedNames.has(String(service.name)),
              ),
            ),
          };

    yield* events.publish(
      PreGlobalStartEvent.make({
        scope: "global",
        app: globalAppRef(loaded.plan),
        plan: loaded.plan,
        triggeredBy: "meta:global:start",
        ensuringServices: [],
        cached: false,
        timestamp: now(),
      }),
    );

    const builtPlan = yield* withBuildProvider(builds.build(planToApply), provider);

    yield* Effect.scoped(
      provider.apply(builtPlan, {
        reconcile: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );

    const servicesStarted = yield* Effect.forEach(services, (service) =>
      provider.inspect({ app: loaded.plan.id, service: service.name, plan: loaded.plan }).pipe(
        Effect.map((runtime) => ({
          name: String(service.name),
          state: runtime.state ?? runtime.status,
          endpoints: (runtime.endpoints ?? service.endpoints).flatMap((endpoint) => {
            const text = hostEndpointText(endpoint);
            return text === undefined ? [] : [text];
          }),
        })),
      ),
    );

    yield* events.publish(
      PostGlobalStartEvent.make({
        scope: "global",
        app: globalAppRef(loaded.plan),
        plan: loaded.plan,
        cached: false,
        timestamp: now(),
      }),
    );

    return { app: loaded.plan.name, servicesStarted };
  });
