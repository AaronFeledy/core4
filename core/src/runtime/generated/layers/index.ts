/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-bootstrap-layers.ts`.
 *
 * Source of truth: `scripts/build-bootstrap-layers.ts`, `BootstrapLevel`, and the
 * core runtime service membership graph.
 *
 * Bootstrap layer composition is emitted ahead of time so hand-authored
 * runtime factories do not rebuild the Effect Layer graph outside this
 * generated output.
 */

import { Layer } from "effect";

import type { BootstrapLevel } from "@lando/sdk/schema";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeAppBootstrapLayer } from "./app.ts";
import { makeCommandsBootstrapLayer } from "./commands.ts";
import { makeGlobalBootstrapLayer } from "./global.ts";
import { makeMinimalBootstrapLayer } from "./minimal.ts";
import { noneBootstrapLayer } from "./none.ts";
import { makePluginsBootstrapBaseLayer } from "./plugins.ts";
import { makeProviderBootstrapLayer } from "./provider.ts";
import { makeScratchBootstrapLayer } from "./scratch.ts";
import { makeToolingBootstrapLayer } from "./tooling.ts";

export const makeGeneratedBootstrapLayer = (bootstrap: BootstrapLevel, inputs: BootstrapLayerInputs) => {
  switch (bootstrap) {
    case "none":
      return noneBootstrapLayer;
    case "minimal":
      return makeMinimalBootstrapLayer(inputs);
    case "plugins":
      return makePluginsBootstrapBaseLayer(inputs);
    case "commands":
      return makeCommandsBootstrapLayer(inputs);
    case "tooling":
      return makeToolingBootstrapLayer(inputs);
    case "provider":
      return makeProviderBootstrapLayer(inputs);
    case "global":
      return makeGlobalBootstrapLayer(inputs);
    case "scratch":
      return makeScratchBootstrapLayer(inputs);
    case "app":
      return makeAppBootstrapLayer(inputs);
  }
};

export const mergeRuntimeWithHostLayers = (
  baseLayer: Layer.Layer<unknown, unknown, unknown>,
  hostLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>,
) => (hostLayers.length === 0 ? baseLayer : Layer.mergeAll(baseLayer, ...hostLayers));
