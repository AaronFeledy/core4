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

import { bundledPluginModules } from "@lando/engine/composition";
import * as GlobalAppRuntimeLayer from "@lando/engine/global-app/runtime";
import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";
import * as ScratchRegistryLayer from "@lando/engine/scratch-app/registry";
import * as ScratchResourceScannerLayer from "@lando/engine/scratch-app/scanner";
import * as ScratchAppServiceLayer from "@lando/engine/scratch-app/service";
import * as BuildOrchestratorLayer from "@lando/engine/services/build-orchestrator";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import * as RouterServiceRegistryLayer from "@lando/engine/subsystems/proxy/registry";
import { mapFailures } from "@lando/sdk/command-result";
import { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import * as ScratchInitAppPortLayer from "../../scratch-init-port.ts";
import { makeProviderBootstrapLayer } from "./provider.ts";

export const makeScratchBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapLayer(inputs);
  const plannerLayer = AppPlannerLayer.layer.pipe(Layer.provide(providerBase));
  const buildOrchestratorLayer = BuildOrchestratorLayer.layer.pipe(Layer.provide(providerBase));
  const scratchBase = Layer.mergeAll(providerBase, plannerLayer, buildOrchestratorLayer);
  const routerRegistryLayer = Layer.fromBuildMemo((memoMap, scope) =>
    Layer.buildWithMemoMap(
      RouterServiceRegistryLayer.RouterServiceRegistry.layerWith(bundledPluginModules()).pipe(
        Layer.provide(scratchBase),
      ),
      memoMap,
      scope,
    ).pipe(
      mapFailures((cause) =>
        cause instanceof ConfigError
          ? cause
          : new LandoRuntimeBootstrapError({
              message: cause instanceof Error ? cause.message : "RouterService bootstrap failed.",
              stage: "provider",
              cause,
              remediation:
                "Check the router plugin routerServices declaration and exported service ids; set defaultRouterService to an installed router id.",
            }),
      ),
    ),
  );
  const globalAppRuntimeLayer = GlobalAppRuntimeLayer.layer.pipe(Layer.provide(scratchBase));
  const routerServiceLayer = Layer.fromBuildMemo((memoMap, scope) =>
    Layer.buildWithMemoMap(
      RouterServiceRegistryLayer.layerSelected.pipe(
        Layer.provide(Layer.mergeAll(scratchBase, globalAppRuntimeLayer, routerRegistryLayer)),
      ),
      memoMap,
      scope,
    ).pipe(
      mapFailures((cause) =>
        cause instanceof ConfigError
          ? cause
          : new LandoRuntimeBootstrapError({
              message: cause instanceof Error ? cause.message : "RouterService bootstrap failed.",
              stage: "provider",
              cause,
              remediation:
                "Set defaultRouterService to an installed router id and repair that plugin RouterService layer before retrying.",
            }),
      ),
    ),
  );
  const scratchDeps = Layer.mergeAll(
    globalAppRuntimeLayer,
    routerRegistryLayer,
    routerServiceLayer,
    ScratchRegistryLayer.ScratchRegistry.layer.pipe(Layer.provide(providerBase)),
    ScratchResourceScannerLayer.ScratchResourceScanner.layer.pipe(Layer.provide(providerBase)),
    ScratchInitAppPortLayer.layer,
  ).pipe(Layer.provideMerge(scratchBase));
  return Layer.mergeAll(
    globalAppRuntimeLayer,
    routerRegistryLayer,
    routerServiceLayer,
    ScratchAppServiceLayer.layer.pipe(Layer.provide(scratchDeps)),
  ).pipe(Layer.provideMerge(scratchDeps));
};
