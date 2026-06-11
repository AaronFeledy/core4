import { Effect, Layer } from "effect";

import type { DeprecationNotice, PluginManifest } from "@lando/sdk/schema";
import { DeprecationService, PluginRegistry } from "@lando/sdk/services";

type DeprecatedPluginManifest = PluginManifest & {
  readonly deprecated?: DeprecationNotice;
};

const registerPluginDeprecations = (manifests: ReadonlyArray<PluginManifest>) =>
  Effect.gen(function* () {
    const deprecations = yield* DeprecationService;
    for (const manifest of manifests as ReadonlyArray<DeprecatedPluginManifest>) {
      if (manifest.deprecated !== undefined) {
        yield* deprecations.register("plugin", "plugin", manifest.name, manifest.deprecated);
      }
    }
  });

export const DeprecationPluginRegistryLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const plugins = yield* PluginRegistry;
    const manifests = yield* plugins.list.pipe(Effect.catchAll(() => Effect.succeed([])));
    yield* registerPluginDeprecations(manifests);
  }),
);
