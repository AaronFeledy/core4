/**
 * `lando start` — start the current app.
 *
 * Bootstrap level: `app`.
 *
 * Programmatic equivalent: `startApp({ reconcile: false })` from
 * `@lando/core/cli`.
 */
import { DateTime, Effect } from "effect";

import type {
  EventError,
  LandoCommandError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileValidationError,
  NoProviderInstalledError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { PostAppStartEvent, PreAppStartEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

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
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
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
  if (endpoint.protocol === "http" || endpoint.protocol === "https")
    return `${endpoint.protocol}://localhost:${endpoint.port}`;
  return `${endpoint.protocol}://localhost:${endpoint.port}`;
};

export const renderStartAppResult = (result: StartAppResult): string => {
  const services = result.servicesStarted
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  return `ready: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};

/**
 * Start the app discovered at the runtime's `cwd`.
 *
 * Bootstrap level: `app`. Requires `LandofileService`, `AppPlanner`,
 * `RuntimeProviderRegistry`, `EventService`, `Logger`.
 *
 * TODO: implement.
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

    yield* events.publish(
      PreAppStartEvent.make({
        eventName: "pre-app-start",
        appRef: ref,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );

    yield* Effect.scoped(
      provider.apply(plan, {
        reconcile: options.reconcile ?? false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );

    const servicesStarted = yield* Effect.forEach(Object.values(plan.services), (service) =>
      provider.inspect({ app: plan.id, service: service.name }).pipe(
        Effect.map((runtime) => ({
          name: String(service.name),
          state: runtime.state ?? runtime.status,
          endpoints: (runtime.endpoints ?? service.endpoints).map(endpointText),
        })),
      ),
    );

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
