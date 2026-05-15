/**
 * `PluginRegistry` Live Layer.
 *
 * MVP discovery is bundled-only: no filesystem scanning and no system, user,
 * app-local, or experimental plugin sources.
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
  loadServiceType: (id) => {
    for (const bundledPlugin of BUNDLED_PLUGINS) {
      const serviceType = bundledPlugin.serviceTypes?.get(id);

      if (serviceType !== undefined) {
        return Effect.succeed(serviceType);
      }
    }

    return Effect.fail(
      new PluginLoadError({
        message: `Bundled service type ${id} is not registered.`,
        pluginName: id,
      }),
    );
  },
};

export { PluginRegistry };

export const PluginRegistryLive = Layer.succeed(PluginRegistry, bundledPluginRegistry);
