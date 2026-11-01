import {
  makeLandoPathsFromRoots,
  normalizeHostPlatform,
  resolveHostHome,
  resolveLandoRootsFromSources,
} from "@lando/paths";
import * as ConfigSources from "@lando/paths/config-sources";
import { ConfigError } from "@lando/sdk/errors";
import type { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, type LandoPaths, PathsService } from "@lando/sdk/services";
import { Context, Effect, Layer, Option, Result } from "effect";
import { type ConfigDecoderInputs, configCommandIds } from "../config/config-command-ids.ts";
import { decodeGlobalConfigSources } from "../config/global-config.ts";

export class GlobalConfigSources extends Context.Service<
  GlobalConfigSources,
  ConfigDecoderInputs & { readonly snapshot?: typeof GlobalConfigSnapshot.Service }
>()("@lando/engine/GlobalConfigSources") {}
export class GlobalConfigSnapshot extends Context.Service<
  GlobalConfigSnapshot,
  {
    readonly config: GlobalConfig;
    readonly inputs: ConfigDecoderInputs;
    readonly paths: LandoPaths;
    readonly warnings: readonly string[];
    readonly takeWarnings: Effect.Effect<readonly string[]>;
  }
>()("@lando/engine/GlobalConfigSnapshot") {}

export interface HostConfigReadPolicy {
  /** Environment for overrides and `${VAR}` expansion; empty when the runtime disables environment sources. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** False when the runtime disables user configuration files. */
  readonly user: boolean;
}

/** How host-side readers of user tool configuration honor this runtime's configuration-source policy. */
export const hostConfigReadPolicy: Effect.Effect<HostConfigReadPolicy | undefined> = Effect.gen(function* () {
  const captured = yield* Effect.serviceOption(GlobalConfigSources);
  if (Option.isNone(captured)) return undefined;
  const { env, sources, rootOverrides } = captured.value;
  return {
    env: sources.env ? env : {},
    home: resolveHostHome({ ...rootOverrides, env: rootOverrides?.env ?? env }),
    user: sources.user,
  };
});

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
    const captured = yield* GlobalConfigSources;
    if (captured.snapshot !== undefined) return snapshotContext(captured.snapshot);
    const sources = yield* Effect.try({
      try: () => ConfigSources.readGlobalConfigSources(captured),
      catch: (cause) =>
        cause instanceof ConfigError
          ? cause
          : new ConfigError({
              message: "Failed to load global config.",
              cause,
              remediation: "Run `lando config validate` and repair the reported keys, then retry.",
            }),
    });
    const commandIds = yield* configCommandIds(sources, captured);
    const decoded = decodeGlobalConfigSources(sources, {
      excessKeys: "warn",
      ...(commandIds === undefined ? {} : { commandIds }),
    });
    if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
    const { config: loaded, warnings } = decoded.success;
    const platform =
      captured.platform ??
      normalizeHostPlatform({ platform: captured.rootOverrides?.platform, env: captured.env });
    let warningsPending = true;
    const snapshot = GlobalConfigSnapshot.of({
      config: loaded,
      inputs: captured,
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

export const layerWith = (inputs: ConfigDecoderInputs) =>
  layerFromSources.pipe(Layer.provideMerge(Layer.succeed(GlobalConfigSources, inputs)));

export const layer = Layer.suspend(() =>
  layerWith({ env: { ...process.env }, sources: { user: true, env: true } }),
);
