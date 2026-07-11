/**
 * `lando destroy` — destroy the current app.
 *
 * Removes containers and the app network. App-scoped storage volumes are
 * preserved by default; pass `volumes: true` to remove data volumes. Cache
 * volumes survive unless `purgeCaches` is also true.
 *
 * Bootstrap level: `app`.
 */
import { rm } from "node:fs/promises";

import { DateTime, Effect, Schema } from "effect";

import type { DestroyAppError, DestroyAppOptions, DestroyAppResult } from "@lando/sdk/app";
import { PostDestroyEvent, PreDestroyEvent } from "@lando/sdk/events";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  LandofileService,
  PathsService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { type ResolvedAppTarget, loadUserLandofile } from "../app-resolution.ts";

import { cleanupHostProxyRunLandoState } from "../../subsystems/host-proxy/transport.ts";
import { terminateFileSyncSessions } from "../file-sync.ts";

export type { DestroyAppError, DestroyAppOptions, DestroyAppResult } from "@lando/sdk/app";

export const DestroyAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesDestroyed: Schema.Array(Schema.String),
  volumesRemoved: Schema.Boolean,
});

type DestroyAppServices =
  | AppPlanner
  | EventService
  | LandofileService
  | PathsService
  | RuntimeProviderRegistry;

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
  target?: ResolvedAppTarget,
): Effect.Effect<DestroyAppResult, DestroyAppError, DestroyAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const events = yield* EventService;
    const paths = yield* PathsService;

    const plan =
      target?.plan ??
      (yield* Effect.gen(function* () {
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities = yield* registry.capabilities;
        return yield* planner.plan(landofile, capabilities);
      }));
    const provider = yield* registry.select(plan);
    const ref = target?.app ?? appRef(plan);
    const volumes = options.volumes ?? false;

    yield* events.publish(
      PreDestroyEvent.make({
        _tag: "pre-destroy",
        app: ref,
        timestamp: now(),
      }),
    );

    yield* terminateFileSyncSessions(ref);

    yield* provider
      .destroy(
        { app: plan.id, plan },
        {
          volumes,
          ...(options.purgeCaches === undefined ? {} : { purgeCaches: options.purgeCaches }),
          removeState: true,
        },
      )
      .pipe(Effect.ensuring(cleanupHostProxyRunLandoState(ref)));

    if (volumes) {
      yield* Effect.promise(() =>
        rm(paths.appSnapshotsDir(String(plan.id)), { recursive: true, force: true }).catch(() => undefined),
      );
    }

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
      volumesRemoved: volumes || options.purgeCaches === true,
    };
  });
