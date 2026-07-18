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

import { LandofileServiceLive } from "../../../landofile/service.ts";
import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";
import { CommandRegistryLive } from "../../../services/command-registry.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makePluginsBootstrapBaseLayer } from "./plugins.ts";

export const makeToolingBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const pluginsRuntimeLive = makePluginsBootstrapBaseLayer(inputs);
  const commandRegistryLive = CommandRegistryLive.pipe(
    Layer.provide(Layer.mergeAll(LandofileServiceLive, pluginsRuntimeLive)),
  );
  const toolingBase = Layer.mergeAll(pluginsRuntimeLive, LandofileServiceLive, commandRegistryLive);
  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(toolingBase));
  return Layer.merge(toolingBase, subscriberRuntimeLive);
};
