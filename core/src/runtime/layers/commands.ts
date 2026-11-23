import { bundledPluginModules } from "@lando/engine/composition";
import * as SubscriberRuntimeLayer from "@lando/engine/lifecycle/subscribers";
import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";
import * as CommandRegistryLayer from "@lando/engine/services/command-registry";
import * as EngineLandofileServiceLayer from "@lando/engine/services/landofile-live";
import * as UserAppResolverLayer from "@lando/engine/services/user-app-resolver";
import { EventService } from "@lando/sdk/services";
import { Context, Layer } from "effect";
import { commandAliasRegistrationError } from "../../cli/command-alias-policy.ts";
import { BUILT_IN_COMMAND_IDS } from "../../cli/generated/command-ids.ts";
import type { MinimalBootstrapLayerInputs } from "./minimal.ts";
import { makePluginsBootstrapBaseLayer } from "./plugins.ts";

export const makeCommandsBootstrapBaseLayer = (inputs: MinimalBootstrapLayerInputs) => {
  const pluginsBase = makePluginsBootstrapBaseLayer(inputs);
  const landofileServiceLayer = EngineLandofileServiceLayer.layerDefault.pipe(Layer.provide(pluginsBase));
  const userAppResolverLayer = UserAppResolverLayer.layer.pipe(Layer.provide(landofileServiceLayer));
  const commandRegistryLayer = CommandRegistryLayer.layerWith((policy, entries, pluginIds) =>
    commandAliasRegistrationError(
      policy,
      entries.map((entry) => entry.id),
      entries,
      pluginIds,
    ),
  ).pipe(Layer.provide(Layer.mergeAll(landofileServiceLayer, pluginsBase)));
  return Layer.mergeAll(pluginsBase, landofileServiceLayer, userAppResolverLayer, commandRegistryLayer).pipe(
    Layer.tap((context) => inputs.lifecycle.complete("commands", Context.get(context, EventService))),
  );
};

export const makeCommandsBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const commandsBase = makeCommandsBootstrapBaseLayer(inputs);
  const subscriberRuntimeLayer = SubscriberRuntimeLayer.layerWithPrivateFileAccess(
    bundledPluginModules(),
    BUILT_IN_COMMAND_IDS,
  ).pipe(Layer.provide(commandsBase));
  return Layer.merge(commandsBase, subscriberRuntimeLayer);
};
