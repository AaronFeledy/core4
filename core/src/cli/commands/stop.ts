/**
 * `lando stop` — stop the current app.
 *
 * Bootstrap level: `app`.
 */
import { DateTime, Effect } from "effect";

import type {
  CapabilityError,
  EventError,
  LandoCommandError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileValidationError,
  NoProviderInstalledError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import {
  PostAppStopEvent,
  PostServiceStopEvent,
  PreAppStopEvent,
  PreServiceStopEvent,
} from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

// biome-ignore lint/suspicious/noEmptyInterface: fields land with implementation
export interface StopAppOptions {}

export interface StopAppResult {
  readonly app: string;
  readonly servicesStopped: ReadonlyArray<string>;
}

type StopAppError =
  | EventError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | CapabilityError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type StopAppServices = AppPlanner | EventService | LandofileService | RuntimeProviderRegistry;

const now = () => DateTime.unsafeMake(new Date().toISOString());

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

export const renderStopAppResult = (result: StopAppResult): string => {
  const services = result.servicesStopped.length === 0 ? "no services" : result.servicesStopped.join(", ");
  return `stopped: ${result.app} - ${services}`;
};

export const stopApp = (
  _options: StopAppOptions = {},
): Effect.Effect<StopAppResult, StopAppError, StopAppServices> =>
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
      PreAppStopEvent.make({
        eventName: "pre-app-stop",
        appRef: ref,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );

    const services = Object.values(plan.services).reverse();
    for (const service of services) {
      yield* events.publish(
        PreServiceStopEvent.make({
          eventName: "pre-service-stop",
          appRef: ref,
          serviceName: service.name,
          providerId: plan.provider,
          timestamp: now(),
        }),
      );
    }

    yield* provider.destroy({ app: plan.id, plan }, { volumes: false, removeState: false });

    for (const service of services) {
      yield* events.publish(
        PostServiceStopEvent.make({
          eventName: "post-service-stop",
          appRef: ref,
          serviceName: service.name,
          providerId: plan.provider,
          timestamp: now(),
        }),
      );
    }

    yield* events.publish(
      PostAppStopEvent.make({
        eventName: "post-app-stop",
        appRef: ref,
        providerId: plan.provider,
        timestamp: now(),
      }),
    );

    return { app: plan.name, servicesStopped: services.map((service) => String(service.name)) };
  });
