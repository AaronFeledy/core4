import { Effect, Schema } from "effect";

import type {
  RebuildAppOptions,
  RebuildAppResult,
  RebuildAppError as SdkRebuildAppError,
} from "@lando/sdk/app";
import type { ComposeKeyRejectedError, LandofileLoadExpressionError } from "@lando/sdk/errors";
import type {
  AppPlanner,
  BuildOrchestrator,
  EventService,
  FileSystem,
  GlobalAppService,
  LandofileService,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
  ShellRunner,
} from "@lando/sdk/services";
import { ProxyService } from "@lando/sdk/services";

import type { RedactionService } from "@lando/redaction/service";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { compensateFailure } from "../lifecycle/failure-compensation.ts";
import { type StartManagedScope, StartedServiceResultSchema, startApp } from "./start.ts";
import { stopAppWithPlan } from "./stop.ts";

export type RebuildAppError = SdkRebuildAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { RebuildAppOptions, RebuildAppResult } from "@lando/sdk/app";

export const RebuildAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesRebuilt: Schema.Array(Schema.String),
  servicesStarted: Schema.Array(StartedServiceResultSchema),
});

type RebuildAppServices =
  | AppPlanner
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | LandofileService
  | PathsService
  | PluginRegistry
  | ProxyService
  | RedactionService
  | RuntimeProviderRegistry
  | ShellRunner;

export const rebuildApp = (
  options: RebuildAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
): Effect.Effect<RebuildAppResult, RebuildAppError, RebuildAppServices> =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService;
    const { plan } = yield* stopAppWithPlan({}, target);
    const start = yield* compensateFailure(
      startApp(
        {
          reconcile: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        target,
        managed,
        { forceAppBuild: true },
      ),
      proxy.removeRoutes(plan.id),
    );
    return {
      app: start.app,
      servicesRebuilt: start.servicesStarted.map((service) => service.name),
      servicesStarted: start.servicesStarted,
    };
  });
