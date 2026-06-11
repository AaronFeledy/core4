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

import { engine as FileSyncEngineLive } from "@lando/file-sync-mutagen";
import { LandofileServiceLive } from "../../../landofile/service.ts";
import { CommandRegistryLive } from "../../../services/command-registry.ts";
import { AppPlannerLive } from "../../../services/planner.ts";
import { ProviderExecToolingEngineLive } from "../../../services/tooling-engine.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeProviderBootstrapLayer } from "./provider.ts";

export const makeAppBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapLayer(inputs);
  return Layer.mergeAll(
    providerBase,
    LandofileServiceLive,
    CommandRegistryLive.pipe(Layer.provide(Layer.mergeAll(LandofileServiceLive, providerBase))),
    AppPlannerLive.pipe(Layer.provide(providerBase)),
    ProviderExecToolingEngineLive,
    FileSyncEngineLive,
  );
};
