import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";
import * as ScratchRegistryLayer from "@lando/engine/scratch-app/registry";
import * as ScratchResourceScannerLayer from "@lando/engine/scratch-app/scanner";
import * as ScratchAppServiceLayer from "@lando/engine/scratch-app/service";
import { Context, Layer } from "effect";
import * as ScratchInitAppPortLayer from "../scratch-init-port.ts";
import { makeAppBootstrapLayer } from "./app.ts";

// A scratch app runs the same lifecycle as a user app, so build on the app graph rather than
// re-declaring it: poweroff stops user apps through that lifecycle, and scratch commands run
// event steps and publish plugin-subscribed events exactly as `lando stop` does.
export const makeScratchBootstrapLayer = (inputs: BootstrapLayerInputs) =>
  Layer.suspend(() => makeAppBootstrapLayer(inputs)).pipe(
    Layer.flatMap((context) => {
      const { hostContext } = Context.get(context, PluginContributionGraph);
      const appLayer = Layer.succeedContext(Context.merge(context, hostContext));
      const scratchSupportLayer = Layer.mergeAll(
        ScratchRegistryLayer.ScratchRegistry.layer,
        ScratchResourceScannerLayer.ScratchResourceScanner.layer,
        ScratchInitAppPortLayer.layer,
      ).pipe(Layer.provide(appLayer));
      return Layer.merge(
        ScratchAppServiceLayer.layer.pipe(
          Layer.provideMerge(scratchSupportLayer),
          Layer.provideMerge(appLayer),
        ),
        // Host layers also take precedence over services introduced by the scratch tier itself.
        Layer.succeedContext(hostContext),
      );
    }),
  );
