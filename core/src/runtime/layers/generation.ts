/** Retained sessions share the host minimal tier across app contribution generations. */

import { withPluginLayerOverrides } from "@lando/engine/plugins/contribution-graph";
import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";
import { superviseBootstrapLayer } from "@lando/engine/runtime/bootstrap-lifecycle";
import type { InteractionService } from "@lando/sdk/services";
import { Layer } from "effect";
import { makeAppBootstrapLayer } from "./app.ts";
import { type MinimalBootstrapLayerInputs, makeMinimalBootstrapLayer } from "./minimal.ts";

/** The retained session host: the minimal tier once, with the session's interaction service. */
export const makeGenerationHostBootstrapLayer = (
  inputs: BootstrapLayerInputs,
  interaction: Layer.Layer<InteractionService>,
) => superviseBootstrapLayer(Layer.merge(makeMinimalBootstrapLayer(inputs), interaction), inputs.lifecycle);

/** One app contribution generation: the app tier over an already-built host minimal tier. */
export const makeGenerationAppBootstrapLayer = (inputs: MinimalBootstrapLayerInputs) =>
  withPluginLayerOverrides(makeAppBootstrapLayer(inputs));
