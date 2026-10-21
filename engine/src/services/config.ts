import { type ConfigSourceInputs, readGlobalConfigSources } from "@lando/paths/config-sources";
import { ConfigError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { type GlobalConfig, GlobalConfigView } from "@lando/sdk/schema";
import { ConfigService, EventService } from "@lando/sdk/services";
import { DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { decodeGlobalConfigFile, decodeGlobalConfigSources } from "../config/global-config.ts";

export { decodeGlobalConfigSources, typoWarningsFromFileConfig } from "../config/global-config.ts";
const warningsByConfig = new WeakMap<GlobalConfig, readonly string[]>();
export const typoWarningsForConfig = (config: GlobalConfig): readonly string[] =>
  warningsByConfig.get(config) ?? [];

export const loadGlobalConfigSync = (
  inputs: ConfigSourceInputs = { env: process.env, sources: { user: true, env: true } },
): GlobalConfig => {
  const result = decodeGlobalConfigSources(readGlobalConfigSources(inputs), { excessKeys: "warn" });
  if (Result.isFailure(result)) throw result.failure;
  warningsByConfig.set(result.success.config, result.success.warnings);
  return result.success.config;
};

export const validateFileHostEvents = (tree: Record<string, unknown>, path: string): void => {
  const result = decodeGlobalConfigFile({ hostEvents: tree.hostEvents }, path);
  if (Result.isFailure(result)) throw result.failure;
};

export const layerWith = (inputs: ConfigSourceInputs) => {
  const load = Effect.gen(function* () {
    const loaded = yield* Effect.try({
      try: () => loadGlobalConfigSync(inputs),
      catch: (cause) =>
        cause instanceof ConfigError
          ? cause
          : new ConfigError({ message: "Failed to load global config.", cause }),
    });
    const events = yield* Effect.serviceOption(EventService);
    if (Option.isSome(events)) {
      for (const body of typoWarningsForConfig(loaded)) {
        yield* events.value
          .publish(MessageWarnEvent.make({ body, timestamp: DateTime.nowUnsafe() }))
          .pipe(Effect.ignore);
      }
    }
    return loaded;
  });
  return Layer.succeed(
    ConfigService,
    ConfigService.of({ load, get: (key) => Effect.map(load, (config) => config[key]) }),
  );
};

export const layer = Layer.suspend(() =>
  layerWith({ env: { ...process.env }, sources: { user: true, env: true } }),
);

export const loadGlobalConfigView = Effect.gen(function* () {
  const service = yield* ConfigService;
  const loaded = yield* service.load;
  return yield* Schema.encodeEffect(GlobalConfigView)(loaded).pipe(
    Effect.mapError(
      (cause) => new ConfigError({ path: "", message: "Failed to project public global config.", cause }),
    ),
  );
});
