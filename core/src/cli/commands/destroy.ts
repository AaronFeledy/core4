/**
 * `lando destroy` — destroy the current app.
 *
 * Removes containers and the app network. App-scoped storage volumes are
 * preserved by default; pass `volumes: true` to also remove app/service
 * scoped volumes. `global` scope volumes always survive `destroy`.
 *
 * Bootstrap level: `app`.
 */
import { DateTime, Effect } from "effect";

import type {
  AppIdReservedError,
  CapabilityError,
  EventError,
  FileSyncDriftError,
  FileSyncStartError,
  FileSyncStopError,
  LandoCommandError,
  LandofileIncludeError,
  LandofileLockMismatchError,
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
import { PostDestroyEvent, PreDestroyEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { loadUserLandofile } from "../app-resolution.ts";

import { terminateFileSyncSessions } from "../file-sync.ts";

export interface DestroyAppOptions {
  readonly volumes?: boolean;
  readonly yes?: boolean;
}

export interface DestroyAppResult {
  readonly app: string;
  readonly servicesDestroyed: ReadonlyArray<string>;
  readonly volumesRemoved: boolean;
}

type DestroyAppError =
  | AppIdReservedError
  | EventError
  | FileSyncDriftError
  | FileSyncStartError
  | FileSyncStopError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NotImplementedError
  | CapabilityError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type DestroyAppServices = AppPlanner | EventService | LandofileService | RuntimeProviderRegistry;

const now = () => DateTime.unsafeMake(new Date().toISOString());

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

export const renderDestroyAppResult = (result: DestroyAppResult): string => {
  const services =
    result.servicesDestroyed.length === 0 ? "no services" : result.servicesDestroyed.join(", ");
  const trailer = result.volumesRemoved ? "volumes removed" : "volumes preserved";
  return `destroyed: ${result.app} - ${services} (${trailer})`;
};

export const destroyApp = (
  options: DestroyAppOptions = {},
): Effect.Effect<DestroyAppResult, DestroyAppError, DestroyAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const events = yield* EventService;

    const landofile = yield* loadUserLandofile(landofileService);
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);
    const provider = yield* registry.select(plan);
    const ref = appRef(plan);
    const volumes = options.volumes ?? false;

    yield* events.publish(
      PreDestroyEvent.make({
        _tag: "pre-destroy",
        app: ref,
        timestamp: now(),
      }),
    );

    yield* terminateFileSyncSessions(ref);

    yield* provider.destroy({ app: plan.id, plan }, { volumes, removeState: true });

    yield* events.publish(
      PostDestroyEvent.make({
        _tag: "post-destroy",
        app: ref,
        timestamp: now(),
      }),
    );

    return {
      app: plan.name,
      servicesDestroyed: Object.values(plan.services)
        .reverse()
        .map((service) => String(service.name)),
      volumesRemoved: volumes,
    };
  });
