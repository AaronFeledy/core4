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

import { AppPlanResolverLive } from "../../../services/app-plan-resolver.ts";
import { BuildOrchestratorLive } from "../../../services/build-orchestrator.ts";
import { AppPlannerLive } from "../../../services/planner.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeProviderBootstrapLayer } from "./provider.ts";

export const makeGlobalBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapLayer(inputs);
  const plannerLive = AppPlannerLive.pipe(Layer.provide(providerBase));
  return Layer.mergeAll(
    providerBase,
    plannerLive,
    AppPlanResolverLive.pipe(Layer.provide(Layer.merge(providerBase, plannerLive))),
    Layer.suspend(() => BuildOrchestratorLive.pipe(Layer.provide(providerBase))),
  );
};
