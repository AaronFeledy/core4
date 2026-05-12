/**
 * `PluginRegistry` Live Layer.
 *
 * Discovery order:
 *   1. Bundled plugins (statically imported into the binary)
 *   2. System plugins (`<systemPluginRoot>/plugins/*`)
 *   3. User plugins (`<userConfRoot>/plugins/*`)
 *   4. App-local `pluginDirs:` (Landofile)
 *   5. Explicit Landofile `plugins:` (with source spec)
 *   6. Experimental plugins (when `experimental: true`)
 *
 * Library mode defaults all discovery sources to `false`.
 *
 * Status: stub.
 */
import { type Context, Effect, Layer } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import { PluginRegistry } from "@lando/sdk/services";

import { BUNDLED_PLUGINS } from "./bundled.ts";

const bundledPluginRegistry: Context.Tag.Service<typeof PluginRegistry> = {
  list: Effect.succeed(BUNDLED_PLUGINS.map((plugin) => plugin.manifest)),
  load: (name) => {
    const bundledPlugin = BUNDLED_PLUGINS.find((plugin) => plugin.name === name);

    if (bundledPlugin) {
      return Effect.succeed(bundledPlugin.manifest);
    }

    return Effect.fail(
      new PluginLoadError({
        message: `Bundled plugin ${name} is not registered.`,
        pluginName: name,
      }),
    );
  },
};

export { PluginRegistry };

export const PluginRegistryLive = Layer.succeed(PluginRegistry, bundledPluginRegistry);
