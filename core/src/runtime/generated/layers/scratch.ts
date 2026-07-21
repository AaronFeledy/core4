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

import { ScratchRegistryLive } from "../../../scratch-app/registry.ts";
import { ScratchResourceScannerLive } from "../../../scratch-app/scanner.ts";
import { ScratchAppServiceLive } from "../../../scratch-app/service.ts";
import { AppPlanResolverLive } from "../../../services/app-plan-resolver.ts";
import { BuildOrchestratorLive } from "../../../services/build-orchestrator.ts";
import { AppPlannerLive } from "../../../services/planner.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeProviderBootstrapLayer } from "./provider.ts";

export const makeScratchBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapLayer(inputs);
  const plannerLive = AppPlannerLive.pipe(Layer.provide(providerBase));
  const resolverLive = AppPlanResolverLive.pipe(Layer.provide(Layer.merge(providerBase, plannerLive)));
  const buildOrchestratorLive = BuildOrchestratorLive.pipe(Layer.provide(providerBase));
  const scratchDeps = Layer.mergeAll(
    providerBase,
    resolverLive,
    buildOrchestratorLive,
    ScratchRegistryLive,
    ScratchResourceScannerLive,
  );
  return Layer.mergeAll(
    providerBase,
    plannerLive,
    resolverLive,
    buildOrchestratorLive,
    ScratchRegistryLive,
    ScratchResourceScannerLive,
    ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)),
  );
};
