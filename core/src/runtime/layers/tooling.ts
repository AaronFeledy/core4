import { bundledPluginModules } from "@lando/engine/composition";
import * as SubscriberRuntimeLayer from "@lando/engine/lifecycle/subscribers";
import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";
import { EventService } from "@lando/sdk/services";
import { Context, Layer } from "effect";
import { BUILT_IN_COMMAND_IDS } from "../../cli/generated/command-ids.ts";
import { makeCommandsBootstrapBaseLayer } from "./commands.ts";

export const makeToolingBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const toolingBase = makeCommandsBootstrapBaseLayer(inputs);
  const subscriberRuntimeLayer = SubscriberRuntimeLayer.layerWithPrivateFileAccess(
    bundledPluginModules(),
    BUILT_IN_COMMAND_IDS,
  ).pipe(Layer.provide(toolingBase));
  return Layer.merge(toolingBase, subscriberRuntimeLayer).pipe(
    Layer.tap((context) => inputs.lifecycle.complete("tooling", Context.get(context, EventService))),
  );
};
