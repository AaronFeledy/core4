/**
 * `lando start` — start the current app.
 *
 * Bootstrap level: `app`.
 *
 * Programmatic equivalent: `startApp({ reconcile: false })` from
 * `@lando/core/cli`.
 */
import { DateTime, Effect, Scope } from "effect";

import type {
  CapabilityError,
  EventError,
  FileSyncDriftError,
  FileSyncStartError,
  FileSyncStopError,
  LandoCommandError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { PostAppStartEvent, PreAppStartEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  FileSyncEngine,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import {
  publishTaskComplete,
  publishTaskFail,
  publishTaskStart,
  publishTreeComplete,
  publishTreeStart,
} from "../progress.ts";

export interface StartAppOptions {
  readonly reconcile?: boolean;
  readonly signal?: AbortSignal;
}

export interface StartAppResult {
  readonly app: string;
  readonly servicesStarted: ReadonlyArray<{
    readonly name: string;
    readonly state: string;
    readonly endpoints: ReadonlyArray<string>;
  }>;
}

type StartAppError =
  | EventError
  | FileSyncDriftError
  | FileSyncStartError
  | FileSyncStopError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | NotImplementedError
  | CapabilityError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type StartAppServices = AppPlanner | EventService | LandofileService | RuntimeProviderRegistry;

const now = () => DateTime.unsafeMake(new Date().toISOString());

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

const endpointText = (endpoint: {
  readonly protocol: string;
  readonly port?: number | undefined;
  readonly socketPath?: string | undefined;
}) => {
  if (endpoint.socketPath !== undefined) return `${endpoint.protocol}:${endpoint.socketPath}`;
  if (endpoint.port === undefined) return endpoint.protocol;
  return `${endpoint.protocol}://localhost:${endpoint.port}`;
};

const READY_STATES = new Set(["running", "ready"]);

const isStartAppReady = (result: StartAppResult): boolean =>
  result.servicesStarted.length > 0 &&
  result.servicesStarted.every((service) => READY_STATES.has(service.state));

export const renderStartAppResult = (result: StartAppResult): string => {
  const services = result.servicesStarted
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  const prefix = isStartAppReady(result) ? "ready" : "starting";
  return `${prefix}: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};

/**
 * Start the app discovered at the runtime's `cwd`.
 *
 * Bootstrap level: `app`. Requires `LandofileService`, `AppPlanner`,
 * `RuntimeProviderRegistry`, `EventService`, `Logger`.
 */
export const startApp = (
  options: StartAppOptions = {},
): Effect.Effect<StartAppResult, StartAppError, StartAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const events = yield* EventService;

    const landofile = yield* landofileService.discover;
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);
    const provider = yield* registry.select(plan);
    const ref = appRef(plan);
    const serviceList = Object.values(plan.services);
    const serviceIds = serviceList.map((service) => String(service.name));
    const applyParentId = `apply-${plan.id}`;
    const applyStart = performance.now();

    yield* events.publish(
      PreAppStartEvent.make({
        eventName: "pre-app-start",
        appRef: ref,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );

    yield* publishTreeStart(events, {
      parentId: applyParentId,
      label: `Apply ${plan.name}`,
      children: serviceIds,
      mode: "list",
    });

    for (const service of serviceList) {
      yield* publishTaskStart(events, {
        taskId: String(service.name),
        parentId: applyParentId,
        label: `Apply service ${String(service.name)}`,
      });
    }

    const applyAndInspect = Effect.gen(function* () {
      yield* Effect.scoped(
        provider.apply(plan, {
          reconcile: options.reconcile ?? false,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      );
      return yield* Effect.forEach(serviceList, (service) =>
        provider.inspect({ app: plan.id, service: service.name }).pipe(
          Effect.map((runtime) => ({
            name: String(service.name),
            state: runtime.state ?? runtime.status,
            endpoints: (runtime.endpoints ?? service.endpoints).map(endpointText),
          })),
        ),
      );
    });

    const servicesStarted = yield* applyAndInspect.pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          for (const service of serviceList) {
            yield* publishTaskFail(events, {
              taskId: String(service.name),
              summary: `Apply service ${String(service.name)}`,
              durationMs: Math.round(performance.now() - applyStart),
            });
          }
          yield* publishTreeComplete(events, {
            parentId: applyParentId,
            summary: `${plan.name} apply failed`,
            succeeded: 0,
            failed: serviceList.length,
            durationMs: Math.round(performance.now() - applyStart),
          });
        }),
      ),
    );

    for (const service of servicesStarted) {
      yield* publishTaskComplete(events, {
        taskId: service.name,
        summary: `${service.name} (${service.state})`,
        durationMs: Math.round(performance.now() - applyStart),
      });
    }

    yield* publishTreeComplete(events, {
      parentId: applyParentId,
      summary: `${plan.name} ready`,
      succeeded: serviceList.length,
      failed: 0,
      durationMs: Math.round(performance.now() - applyStart),
    });

    if (plan.fileSync.length > 0) {
      const engineOption = yield* Effect.serviceOption(FileSyncEngine);
      if (engineOption._tag === "Some") {
        const engine = engineOption.value;
        for (const entry of plan.fileSync) {
          const sessionScope = yield* Scope.make();
          yield* engine.createSession(entry.session).pipe(Effect.provideService(Scope.Scope, sessionScope));
        }
      }
    }

    yield* events.publish(
      PostAppStartEvent.make({
        eventName: "post-app-start",
        appRef: ref,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );

    return { app: plan.name, servicesStarted };
  });
