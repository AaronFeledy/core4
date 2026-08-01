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

import { Context, Layer } from "effect";

import { EventService } from "@lando/sdk/services";
import { DeprecationPluginRegistryLive } from "../../../deprecation/plugin-registry.ts";
import { makePluginContributionGraphLive } from "../../../plugins/contribution-graph.ts";
import { makePluginRegistryLive } from "../../../plugins/registry.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeMinimalBootstrapLayer } from "./minimal.ts";

export const makePluginsBootstrapBaseLayer = (inputs: BootstrapLayerInputs) => {
  const minimalRuntimeLive = makeMinimalBootstrapLayer(inputs);
  const contributionGraphLive = makePluginContributionGraphLive({
    layers: inputs.pluginLayers,
    manifests: inputs.pluginManifests,
    discovery: inputs.pluginDiscovery,
    externalImports: inputs.externalImports,
    cwd: inputs.cwd,
  }).pipe(Layer.provide(minimalRuntimeLive));
  const pluginRegistryLive = makePluginRegistryLive(inputs.pluginDiscovery).pipe(
    Layer.provide(Layer.merge(minimalRuntimeLive, contributionGraphLive)),
  );
  const deprecationRegistryLive = DeprecationPluginRegistryLive.pipe(
    Layer.provide(Layer.mergeAll(minimalRuntimeLive, pluginRegistryLive)),
  );
  return Layer.mergeAll(
    minimalRuntimeLive,
    contributionGraphLive,
    pluginRegistryLive,
    deprecationRegistryLive,
  ).pipe(Layer.tap((context) => inputs.lifecycle.complete("plugins", Context.get(context, EventService))));
};
