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

import { bundledPluginModules } from "@lando/engine/composition";
import * as GlobalAppRuntimeLayer from "@lando/engine/global-app/runtime";
import * as SubscriberRuntimeLayer from "@lando/engine/lifecycle/subscribers";
import * as BuildOrchestratorLayer from "@lando/engine/services/build-orchestrator";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import * as ProviderExecToolingEngine from "@lando/engine/services/tooling-engine";
import * as RouterServiceRegistryLayer from "@lando/engine/subsystems/proxy/registry";
import { mapFailures } from "@lando/sdk/command-result";
import { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";
import * as EventCommandExecutorLayer from "../../../cli/event-command-executor.ts";
import { BUILT_IN_COMMAND_IDS } from "../../../cli/generated/command-ids.ts";
import type { MinimalBootstrapLayerInputs } from "./minimal.ts";
import { makeProviderBootstrapBaseLayer } from "./provider.ts";

export const makeAppBootstrapLayer = (inputs: MinimalBootstrapLayerInputs) => {
  const providerGraph = makeProviderBootstrapBaseLayer(inputs);
  const providerBase = Layer.suspend(() => providerGraph);
  const buildOrchestratorLayer = Layer.suspend(() =>
    BuildOrchestratorLayer.layer.pipe(Layer.provide(providerBase)),
  );
  const appBase = Layer.mergeAll(
    providerBase,
    buildOrchestratorLayer,
    AppPlannerLayer.layer.pipe(Layer.provide(providerBase)),
    ProviderExecToolingEngine.layer.pipe(Layer.provide(providerBase)),
  );
  const routerRegistryLayer = Layer.fromBuildMemo((memoMap, scope) =>
    Layer.buildWithMemoMap(
      RouterServiceRegistryLayer.RouterServiceRegistry.layerWith(bundledPluginModules()).pipe(
        Layer.provide(appBase),
      ),
      memoMap,
      scope,
    ).pipe(
      mapFailures((cause) =>
        cause instanceof ConfigError
          ? cause
          : new LandoRuntimeBootstrapError({
              message: cause instanceof Error ? cause.message : "RouterService bootstrap failed.",
              stage: "app",
              cause,
              remediation:
                "Check the router plugin routerServices declaration and exported service ids; set defaultRouterService to an installed router id.",
            }),
      ),
    ),
  );
  const globalAppRuntimeLayer = GlobalAppRuntimeLayer.layer.pipe(Layer.provide(appBase));
  const routerServiceLayer = Layer.fromBuildMemo((memoMap, scope) =>
    Layer.buildWithMemoMap(
      RouterServiceRegistryLayer.layerSelected.pipe(
        Layer.provide(Layer.mergeAll(appBase, globalAppRuntimeLayer, routerRegistryLayer)),
      ),
      memoMap,
      scope,
    ).pipe(
      mapFailures((cause) =>
        cause instanceof ConfigError
          ? cause
          : new LandoRuntimeBootstrapError({
              message: cause instanceof Error ? cause.message : "RouterService bootstrap failed.",
              stage: "app",
              cause,
              remediation:
                "Set defaultRouterService to an installed router id and repair that plugin RouterService layer before retrying.",
            }),
      ),
    ),
  );
  const fullAppBase = Layer.mergeAll(appBase, globalAppRuntimeLayer, routerRegistryLayer, routerServiceLayer);
  const eventCommandExecutorLayer = EventCommandExecutorLayer.layer.pipe(Layer.provide(fullAppBase));
  const runtimeAppBase = Layer.merge(fullAppBase, eventCommandExecutorLayer);
  const subscriberRuntimeLayer = SubscriberRuntimeLayer.layerWithPrivateFileAccess(
    bundledPluginModules(),
    BUILT_IN_COMMAND_IDS,
  ).pipe(Layer.provide(runtimeAppBase));
  return Layer.merge(runtimeAppBase, subscriberRuntimeLayer).pipe(
    Layer.tap((context) => inputs.lifecycle.complete("app", Context.get(context, EventService))),
  );
};
