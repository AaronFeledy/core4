import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";

import * as BuildOrchestratorLayer from "@lando/engine/services/build-orchestrator";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { Layer } from "effect";
import { makeProviderBootstrapLayer } from "./provider.ts";

export const makeGlobalBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapLayer(inputs);
  return Layer.mergeAll(
    providerBase,
    AppPlannerLayer.layer.pipe(Layer.provide(providerBase)),
    Layer.suspend(() => BuildOrchestratorLayer.layer.pipe(Layer.provide(providerBase))),
  );
};
