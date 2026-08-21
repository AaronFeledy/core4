import { Context, Effect, Layer } from "effect";

import { GlobalAppError } from "@lando/sdk/errors";
import {
  AppPlanner,
  BuildOrchestrator,
  ConfigService,
  EventService,
  FileSystem,
  GlobalAppService,
  PluginRegistry,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { ensureGlobalServicesRunning } from "../operations/ensure-global-services.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";

export const GlobalAppRuntimeLive = Layer.effect(
  GlobalAppService,
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const context = Context.make(GlobalAppService, globalApp).pipe(
      Context.add(AppPlanner, yield* AppPlanner),
      Context.add(BuildOrchestrator, yield* BuildOrchestrator),
      Context.add(ConfigService, yield* ConfigService),
      Context.add(EventService, yield* EventService),
      Context.add(FileSystem, yield* FileSystem),
      Context.add(PluginRegistry, yield* PluginRegistry),
      Context.add(RuntimeProviderRegistry, yield* RuntimeProviderRegistry),
    );
    return {
      ...globalApp,
      ensureRunning: (services) =>
        ensureGlobalServicesRunning({ services }).pipe(
          Effect.provide(context),
          Effect.map((result) => result.servicesStarted),
          Effect.mapError(
            (cause) =>
              new GlobalAppError({
                message: "Unable to ensure global services are running.",
                operation: "ensureRunning",
                remediation:
                  taggedErrorRemediation(cause) ??
                  "Lando tried to install and start the required global services automatically. Fix the underlying error, then retry.",
                cause,
              }),
          ),
        ),
    };
  }),
);
