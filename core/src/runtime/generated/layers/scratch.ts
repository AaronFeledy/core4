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

import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { GlobalAppRuntimeLive } from "../../../global-app/runtime.ts";
import { ScratchRegistryLive } from "../../../scratch-app/registry.ts";
import { ScratchResourceScannerLive } from "../../../scratch-app/scanner.ts";
import { ScratchAppServiceLive } from "../../../scratch-app/service.ts";
import { BuildOrchestratorLive } from "../../../services/build-orchestrator.ts";
import { AppPlannerLive } from "../../../services/planner.ts";
import { ProxyServiceRegistryLive, SelectedProxyServiceLive } from "../../../subsystems/proxy/registry.ts";
import type { BootstrapLayerInputs } from "../../bootstrap-layer-support.ts";
import { makeProviderBootstrapLayer } from "./provider.ts";

export const makeScratchBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapLayer(inputs);
  const plannerLive = AppPlannerLive.pipe(Layer.provide(providerBase));
  const buildOrchestratorLive = BuildOrchestratorLive.pipe(Layer.provide(providerBase));
  const scratchBase = Layer.mergeAll(providerBase, plannerLive, buildOrchestratorLive);
  const proxyRegistryLive = ProxyServiceRegistryLive.pipe(
    Layer.provide(scratchBase),
    Layer.mapError(
      (cause) =>
        new LandoRuntimeBootstrapError({
          message: cause instanceof Error ? cause.message : "ProxyService bootstrap failed.",
          stage: "provider",
          cause,
        }),
    ),
  );
  const globalAppRuntimeLive = GlobalAppRuntimeLive.pipe(Layer.provide(scratchBase));
  const proxyServiceLive = SelectedProxyServiceLive.pipe(
    Layer.provide(Layer.mergeAll(scratchBase, globalAppRuntimeLive, proxyRegistryLive)),
    Layer.mapError(
      (cause) =>
        new LandoRuntimeBootstrapError({
          message: cause instanceof Error ? cause.message : "ProxyService bootstrap failed.",
          stage: "provider",
          cause,
        }),
    ),
  );
  const scratchDeps = Layer.mergeAll(
    scratchBase,
    globalAppRuntimeLive,
    proxyRegistryLive,
    proxyServiceLive,
    ScratchRegistryLive,
    ScratchResourceScannerLive,
  );
  return Layer.mergeAll(
    scratchBase,
    globalAppRuntimeLive,
    proxyRegistryLive,
    proxyServiceLive,
    ScratchRegistryLive,
    ScratchResourceScannerLive,
    ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)),
  );
};
