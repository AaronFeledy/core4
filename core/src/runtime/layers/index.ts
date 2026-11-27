import { withPluginLayerOverrides } from "@lando/engine/plugins/contribution-graph";
import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";
import { superviseBootstrapLayer } from "@lando/engine/runtime/bootstrap-lifecycle";
import type { BootstrapLevel } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect, Layer, Option } from "effect";
import { makeAppBootstrapLayer } from "./app.ts";
import { makeCommandsBootstrapLayer } from "./commands.ts";
import { makeGlobalBootstrapLayer } from "./global.ts";
import { makeMinimalBootstrapLayer } from "./minimal.ts";
import { makeNoneBootstrapLayer } from "./none.ts";
import { makePluginsBootstrapBaseLayer } from "./plugins.ts";
import { makeProviderBootstrapLayer } from "./provider.ts";
import { makeScratchBootstrapLayer } from "./scratch.ts";
import { makeToolingBootstrapLayer } from "./tooling.ts";

export const makeBootstrapLayer = (bootstrap: BootstrapLevel, inputs: BootstrapLayerInputs) => {
  switch (bootstrap) {
    case "none":
      return makeNoneBootstrapLayer(inputs);
    case "minimal":
      return makeMinimalBootstrapLayer(inputs);
    case "plugins":
      return withPluginLayerOverrides(makePluginsBootstrapBaseLayer(inputs));
    case "commands":
      return withPluginLayerOverrides(makeCommandsBootstrapLayer(inputs));
    case "tooling":
      return withPluginLayerOverrides(makeToolingBootstrapLayer(inputs));
    case "provider":
      return withPluginLayerOverrides(makeProviderBootstrapLayer(inputs));
    case "global":
      return withPluginLayerOverrides(makeGlobalBootstrapLayer(inputs));
    case "scratch":
      return makeScratchBootstrapLayer(inputs);
    case "app":
      return withPluginLayerOverrides(makeAppBootstrapLayer(inputs));
  }
};

export const mergeRuntimeWithHostLayers = (
  baseLayer: Layer.Layer<unknown, unknown, unknown>,
  hostLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>,
  bootstrap: BootstrapLevel,
  lifecycle: BootstrapLayerInputs["lifecycle"],
) => {
  const runtime = hostLayers.reduce((current, hostLayer) => {
    const captureEventService = Layer.effectDiscard(
      Effect.serviceOption(EventService).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: lifecycle.useEventService,
          }),
        ),
      ),
    );
    const observedHostLayer = captureEventService.pipe(Layer.provideMerge(hostLayer));
    return observedHostLayer.pipe(Layer.provideMerge(current));
  }, baseLayer);
  return bootstrap === "none" ? runtime : superviseBootstrapLayer(runtime, lifecycle);
};
