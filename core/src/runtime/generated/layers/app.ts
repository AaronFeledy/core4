/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-bootstrap-layers.ts`.
 *
 * Source of truth: `scripts/build-bootstrap-layers.ts`, `BootstrapLevel`, and the
 * core runtime service membership graph (§3.4).
 *
 * Bootstrap layer composition is emitted ahead of time so hand-authored
 * runtime factories do not rebuild the Effect Layer graph outside this
 * generated output.
 */

import { Layer } from "effect";

import { engine as FileSyncEngineLive } from "@lando/file-sync-mutagen";
import { CacheServiceLive } from "../../../cache/service.ts";
import { LandofileServiceLive } from "../../../landofile/service.ts";
import { makePluginRegistryLive } from "../../../plugins/registry.ts";
import { CommandRegistryLive } from "../../../services/command-registry.ts";
import { AppPlannerLive } from "../../../services/planner.ts";
import { ProviderExecToolingEngineLive } from "../../../services/tooling-engine.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeMinimalBootstrapLayer } from "./minimal.ts";
import { makeProviderBootstrapLayer } from "./provider.ts";

export const makeAppBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const minimalRuntimeLive = makeMinimalBootstrapLayer(inputs);
  const pluginRegistryLive = makePluginRegistryLive(inputs.pluginDiscovery).pipe(
    Layer.provide(minimalRuntimeLive),
  );
  return Layer.mergeAll(
    makeProviderBootstrapLayer(inputs),
    LandofileServiceLive,
    CommandRegistryLive.pipe(Layer.provide(Layer.mergeAll(LandofileServiceLive, pluginRegistryLive))),
    AppPlannerLive.pipe(Layer.provide(Layer.mergeAll(pluginRegistryLive, CacheServiceLive))),
    ProviderExecToolingEngineLive,
    FileSyncEngineLive,
  );
};
