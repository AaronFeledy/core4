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

import { CacheServiceLive } from "../../../cache/service.ts";
import { LandofileServiceLive } from "../../../landofile/service.ts";
import { makePluginRegistryLive } from "../../../plugins/registry.ts";
import { ScratchRegistryLive } from "../../../scratch-app/registry.ts";
import { ScratchResourceScannerLive } from "../../../scratch-app/scanner.ts";
import { ScratchAppServiceLive } from "../../../scratch-app/service.ts";
import { ConfigServiceLive } from "../../../services/config.ts";
import { AppPlannerLive } from "../../../services/planner.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeMinimalBootstrapLayer } from "./minimal.ts";
import { makeProviderBootstrapLayer } from "./provider.ts";

export const makeScratchBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapLayer(inputs);
  const minimalRuntimeLive = makeMinimalBootstrapLayer(inputs);
  const pluginRegistryLive = makePluginRegistryLive(inputs.pluginDiscovery).pipe(
    Layer.provide(minimalRuntimeLive),
  );
  const plannerLive = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(pluginRegistryLive, CacheServiceLive, ConfigServiceLive)),
  );
  const scratchDeps = Layer.mergeAll(
    providerBase,
    LandofileServiceLive,
    plannerLive,
    ScratchRegistryLive,
    ScratchResourceScannerLive,
  );
  return Layer.mergeAll(
    providerBase,
    LandofileServiceLive,
    plannerLive,
    ScratchRegistryLive,
    ScratchResourceScannerLive,
    ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)),
  );
};
