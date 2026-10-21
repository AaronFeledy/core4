import { makeLandoPathsFromRoots, normalizeHostPlatform, resolveLandoRootsFromSources } from "@lando/paths";
import type { ConfigSourceInputs } from "@lando/paths/config-sources";
import * as ConfigSources from "@lando/paths/config-sources";
import { ConfigError } from "@lando/sdk/errors";
import type { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, type LandoPaths, PathsService } from "@lando/sdk/services";
import { Context, Effect, Layer, Option, Result } from "effect";
import { decodeGlobalConfigSources } from "../config/global-config.ts";

export class GlobalConfigSources extends Context.Service<GlobalConfigSources, ConfigSourceInputs>()(
  "@lando/engine/GlobalConfigSources",
) {}
export class GlobalConfigSnapshot extends Context.Service<
  GlobalConfigSnapshot,
  {
    readonly config: GlobalConfig;
    readonly paths: LandoPaths;
    readonly warnings: readonly string[];
    readonly takeWarnings: Effect.Effect<readonly string[]>;
  }
>()("@lando/engine/GlobalConfigSnapshot") {}

const snapshotContext = (snapshot: typeof GlobalConfigSnapshot.Service) =>
  Context.make(
    ConfigService,
    ConfigService.of({
      load: Effect.succeed(snapshot.config),
      get: (key) => Effect.succeed(snapshot.config[key]),
    }),
  ).pipe(Context.add(GlobalConfigSnapshot, snapshot), Context.add(PathsService, snapshot.paths));

export const layerFromSources = Layer.effectContext(
  Effect.gen(function* () {
    const supplied = yield* Effect.serviceOption(GlobalConfigSnapshot);
    if (Option.isSome(supplied)) return snapshotContext(supplied.value);
    const captured = yield* GlobalConfigSources;
    const sources = yield* Effect.try({
      try: () => ConfigSources.readGlobalConfigSources(captured),
      catch: (cause) =>
        cause instanceof ConfigError
          ? cause
          : new ConfigError({ message: "Failed to load global config.", cause }),
    });
    const decoded = decodeGlobalConfigSources(sources, { excessKeys: "warn" });
    if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
    const { config: loaded, warnings } = decoded.success;
    const platform =
      captured.platform ??
      normalizeHostPlatform({ platform: captured.rootOverrides?.platform, env: captured.env });
    let warningsPending = true;
    const snapshot = GlobalConfigSnapshot.of({
      config: loaded,
      paths: makeLandoPathsFromRoots(resolveLandoRootsFromSources(sources), platform),
      warnings,
      takeWarnings: Effect.sync(() => {
        if (!warningsPending) return [];
        warningsPending = false;
        return warnings;
      }),
    });
    return snapshotContext(snapshot);
  }),
);

export const layerWith = (inputs: ConfigSourceInputs) =>
  layerFromSources.pipe(Layer.provideMerge(Layer.succeed(GlobalConfigSources, inputs)));

export const layer = Layer.suspend(() =>
  layerWith({ env: { ...process.env }, sources: { user: true, env: true } }),
);
