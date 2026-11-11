import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import * as LandofileServiceLayer from "@lando/engine/services/landofile-live";
import { GlobalAppService, LandofileService } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { type AppConfigOptions, appConfig, describeAppConfig } from "./commands/app-config.ts";
import {
  type GlobalConfigOptions,
  describeGlobalConfig,
  globalConfig,
} from "./commands/meta/global-config.ts";

export const runAppConfig = Effect.fnUntraced(function* (options: AppConfigOptions) {
  if (options.subcommand === "describe") return yield* describeAppConfig(options);
  const existing = yield* Effect.serviceOption(LandofileService);
  const operation = appConfig(options);
  return yield* Option.isSome(existing)
    ? operation.pipe(Effect.provideService(LandofileService, existing.value))
    : operation.pipe(Effect.provide(LandofileServiceLayer.layerDefault));
});

export const runGlobalConfig = Effect.fnUntraced(function* ({ subcommand, ...options }: GlobalConfigOptions) {
  if (subcommand === "describe") return yield* describeGlobalConfig(options);
  const existing = yield* Effect.serviceOption(GlobalAppService);
  const operation = globalConfig(subcommand === undefined ? options : { ...options, subcommand });
  return yield* Option.isSome(existing)
    ? operation.pipe(Effect.provideService(GlobalAppService, existing.value))
    : operation.pipe(Effect.provide(GlobalAppServiceLayer.layer));
});
