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

import { DeprecationPluginRegistryLive } from "../../../deprecation/plugin-registry.ts";
import { makePluginRegistryLive } from "../../../plugins/registry.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeMinimalBootstrapLayer } from "./minimal.ts";

export const makePluginsBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const minimalRuntimeLive = makeMinimalBootstrapLayer(inputs);
  const pluginRegistryLive = makePluginRegistryLive(inputs.pluginDiscovery).pipe(
    Layer.provide(minimalRuntimeLive),
  );
  const deprecationRegistryLive = DeprecationPluginRegistryLive.pipe(
    Layer.provide(Layer.mergeAll(minimalRuntimeLive, pluginRegistryLive)),
  );
  return Layer.mergeAll(minimalRuntimeLive, pluginRegistryLive, deprecationRegistryLive);
};
