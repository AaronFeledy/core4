import { type GlobalMutationServices, withGlobalMutation } from "@lando/engine/global-app/mutation";
import {
  recordGlobalResourceCleanup,
  recordGlobalRouteCleanup,
} from "@lando/engine/global-app/reconciliation";
import { DateTime, Effect, Layer, Schema } from "effect";

import { type EventError, GlobalAppError, type ProxyError } from "@lando/sdk/errors";

import { PostGlobalStopEvent, PreGlobalStopEvent } from "@lando/sdk/events";
import { AbsolutePath, type ProviderId, StopAppOutcome, StopAppResult } from "@lando/sdk/schema";
import { EventService, FileSystem, GlobalAppService, RouterService } from "@lando/sdk/services";
import { makeGlobalAppServiceForRoot } from "../global-app/service.ts";
import { CertificateAuthorityResolver } from "../plugins/certificate-authority-resolver.ts";
import { TeardownProvider } from "../providers/app-placement.ts";
import * as DeferredCertificateAuthority from "../subsystems/proxy/deferred-certificate-authority.ts";
import { RouterServiceRegistry } from "../subsystems/proxy/registry.ts";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";
import { withGlobalLifecycleEvents } from "./global-common";
import { withShutdownObservations } from "./shutdown-observations.ts";

import {
  executeGlobalStopSelection,
  executeGlobalTeardown,
  globalTeardownAppRef,
  resolveGlobalStopSelection,
  resolveGlobalTeardown,
} from "@lando/engine/operations/global-teardown";

const now = () => DateTime.nowUnsafe();

export const GlobalStopResultSchema = Schema.Struct({
  app: StopAppResult.fields.app,
  outcome: StopAppOutcome,
  materialized: Schema.Boolean.annotate({
    description: "Whether the global app has a materialized Landofile.",
  }),
  servicesStopped: StopAppResult.fields.servicesStopped,
  shutdownObservations: StopAppResult.fields.shutdownObservations,
});

export type GlobalStopResult = typeof GlobalStopResultSchema.Type;
export type GlobalStopOptions = {
  readonly services?: ReadonlyArray<string>;
  readonly target?: { readonly root: AbsolutePath; readonly providerId: ProviderId };
  readonly triggeredBy?: typeof PreGlobalStopEvent.Type.triggeredBy;
};

export type GlobalStopError =
  | Effect.Error<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Error<ReturnType<typeof executeGlobalTeardown>>
  | Effect.Error<ReturnType<typeof resolveGlobalStopSelection>>
  | Effect.Error<ReturnType<typeof executeGlobalStopSelection>>
  | import("@lando/sdk/errors").GlobalAppError
  | EventError
  | ProxyError;

export type GlobalStopServices =
  | GlobalMutationServices
  | Effect.Services<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Services<ReturnType<typeof executeGlobalTeardown>>
  | Effect.Services<ReturnType<typeof resolveGlobalStopSelection>>
  | Effect.Services<ReturnType<typeof executeGlobalStopSelection>>
  | Effect.Services<ReturnType<typeof recordGlobalResourceCleanup>>
  | EventService
  | RouterService;

export const globalStop = Effect.fn("GlobalStop.stop")(
  function* (
    options: GlobalStopOptions = {},
  ): Effect.fn.Return<GlobalStopResult, GlobalStopError, GlobalStopServices> {
    const loaded = yield* resolveGlobalTeardown();
    if (loaded.evidence.kind === "absent") {
      if (!options.services?.length) {
        const router = yield* RouterService;
        yield* router.removeRoutes(globalTeardownAppRef(loaded).id);
        yield* recordGlobalRouteCleanup();
      }
      return { app: "global", outcome: "unchanged", materialized: loaded.materialized, servicesStopped: [] };
    }
    const selection = options.services?.length
      ? yield* resolveGlobalStopSelection(loaded, options.services)
      : undefined;
    if (selection?.services.length === 0) {
      yield* executeGlobalStopSelection(loaded, selection);
      return { app: "global", outcome: "unchanged", materialized: loaded.materialized, servicesStopped: [] };
    }
    const events = yield* EventService;
    const app = globalTeardownAppRef(loaded);

    return yield* withGlobalLifecycleEvents(
      {
        pre: () =>
          events.publish(
            PreGlobalStopEvent.make({
              scope: "global",
              app,
              triggeredBy: options.triggeredBy ?? "meta:global:stop",
              timestamp: now(),
            }),
          ),
        post: () =>
          events.publish(
            PostGlobalStopEvent.make({
              scope: "global",
              app,
              timestamp: now(),
            }),
          ),
      },
      Effect.gen(function* () {
        const receipt =
          selection === undefined
            ? yield* executeGlobalTeardown(loaded, { intent: "stop", volumes: false, removeState: false })
            : yield* executeGlobalStopSelection(loaded, selection);
        if (selection === undefined) {
          const router = yield* RouterService;
          yield* router.removeRoutes(app.id);
          yield* recordGlobalResourceCleanup();
        }
        return withShutdownObservations(
          {
            app: "global",
            outcome: receipt.changed ? ("stopped" as const) : ("unchanged" as const),
            materialized: loaded.materialized,
            servicesStopped: receipt.services,
          },
          receipt.shutdownObservations,
        );
      }),
    );
  },
  (effect, options: GlobalStopOptions = {}) =>
    Effect.gen(function* () {
      if (options.target === undefined) return yield* withGlobalMutation(effect);
      // Scope every teardown read, receipt and coordinator to discovery, not current configuration.
      const root = AbsolutePath.make(yield* canonicalMissingAppRoot(options.target.root));
      const configuredRoot = yield* canonicalMissingAppRoot((yield* (yield* GlobalAppService).paths).root);
      const fileSystem = yield* FileSystem;
      const targeted = GlobalAppService.of({
        ...makeGlobalAppServiceForRoot(Effect.succeed(root), fileSystem),
        providerId: Effect.succeed(options.target.providerId),
      });
      const targetedWork =
        configuredRoot === root
          ? effect
          : Effect.gen(function* () {
              const routers = yield* Effect.serviceOption(RouterServiceRegistry);
              const authorities = yield* Effect.serviceOption(CertificateAuthorityResolver);
              if (routers._tag === "None" || authorities._tag === "None")
                return yield* Effect.fail(
                  new GlobalAppError({
                    operation: "target-router",
                    message: "The router cannot be safely rebound to the discovered global root.",
                    remediation:
                      "Run the command with that installation's roots, or provide router and certificate-authority registries in the embedded runtime.",
                  }),
                );
              const current = yield* RouterService;
              const selected = yield* routers.value.select({ explicit: current.id });
              const authority = DeferredCertificateAuthority.layer.pipe(
                Layer.provide(Layer.succeed(CertificateAuthorityResolver, authorities.value)),
              );
              return yield* effect.pipe(Effect.provide(selected.layer.pipe(Layer.provide(authority))));
            });
      return yield* withGlobalMutation(targetedWork).pipe(
        Effect.provideService(GlobalAppService, targeted),
        Effect.provideService(TeardownProvider, options.target.providerId),
      );
    }),
);
