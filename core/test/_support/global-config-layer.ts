import { join } from "node:path";
import { makeLandoPaths } from "@lando/core/paths";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { GlobalAppService, PathsService, PluginRegistry } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { layerWithPrivateFileAccess } from "@lando/state-store/service";
import { Effect, Layer } from "effect";

/** Real operation locks and isolated policy state for direct config entrypoints. */
export const globalConfigLayer = (root: string) => {
  const paths = makeLandoPaths({
    userDataRoot: join(root, "state"),
    userCacheRoot: join(root, "cache"),
    userConfRoot: join(root, "conf"),
    systemPluginRoot: join(root, "sys"),
    env: {},
    platform: "linux",
  });
  const dependencies = Layer.merge(Layer.succeed(PathsService, paths), PrivateFileAccessService.layer);
  return Layer.mergeAll(
    dependencies,
    layerWithPrivateFileAccess.pipe(Layer.provide(dependencies)),
    Layer.succeed(
      GlobalAppService,
      GlobalAppService.of({
        id: "global",
        root: Effect.succeed(AbsolutePath.make(root)),
        paths: Effect.succeed({
          root: AbsolutePath.make(root),
          distLandofile: AbsolutePath.make(join(root, ".lando.dist.yml")),
          userLandofile: AbsolutePath.make(join(root, ".lando.yml")),
        }),
        providerId: Effect.succeed(ProviderId.make("lando")),
        ensureRoot: Effect.die("config must not initialize global runtime"),
        ensureRunning: () => Effect.die("config must not start global runtime"),
        ensureUserLandofile: Effect.die("explicit config file must be used"),
        regenerateDist: () => Effect.die("config must not regenerate defaults"),
      }),
    ),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed([]),
        load: () => Effect.die("no plugins in config fixture"),
        loadServiceType: () => Effect.die("no service plugins in config fixture"),
        loadServiceFeature: () => Effect.die("no service features in config fixture"),
        loadAppFeature: () => Effect.die("no app features in config fixture"),
      }),
    ),
  );
};

export type GlobalConfigTestServices = Layer.Success<ReturnType<typeof globalConfigLayer>>;
