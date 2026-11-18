import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";
import * as ScratchRegistryLayer from "@lando/engine/scratch-app/registry";
import * as ScratchResourceScannerLayer from "@lando/engine/scratch-app/scanner";
import * as ScratchAppServiceLayer from "@lando/engine/scratch-app/service";
import { Layer } from "effect";
import * as ScratchInitAppPortLayer from "../scratch-init-port.ts";
import { makeAppBootstrapLayer } from "./app.ts";

// A scratch app runs the same lifecycle as a user app, so build on the app graph rather than
// re-declaring it: poweroff stops user apps through that lifecycle, and scratch commands run
// event steps and publish plugin-subscribed events exactly as `lando stop` does.
export const makeScratchBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const appLayer = Layer.suspend(() => makeAppBootstrapLayer(inputs));
  const scratchSupportLayer = Layer.mergeAll(
    ScratchRegistryLayer.ScratchRegistry.layer,
    ScratchResourceScannerLayer.ScratchResourceScanner.layer,
    ScratchInitAppPortLayer.layer,
  ).pipe(Layer.provide(appLayer));
  return ScratchAppServiceLayer.layer.pipe(
    Layer.provideMerge(scratchSupportLayer),
    Layer.provideMerge(appLayer),
  );
};
