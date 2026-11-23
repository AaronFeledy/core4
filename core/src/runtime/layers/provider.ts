import * as ContainerHelperAssetsLayer from "@lando/container-runtime/container-helper/assets";
import * as BunDataMover from "@lando/data-mover/service";
import { bundledPluginModules } from "@lando/engine/composition";
import * as GlobalAppRuntimeLayer from "@lando/engine/global-app/runtime";
import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import * as LocalCaTrustLayer from "@lando/engine/http/local-ca-trust";
import * as SubscriberRuntimeLayer from "@lando/engine/lifecycle/subscribers";
import * as PlannedServiceReadiness from "@lando/engine/operations/service-readiness";
import * as CertificateAuthorityResolverLayer from "@lando/engine/plugins/certificate-authority-resolver";
import * as FileSyncResolverLayer from "@lando/engine/plugins/file-sync-resolver";
import { makeRuntimeProviderRegistryWithPrivateFileAccess } from "@lando/engine/providers/registry";
import {
  type BootstrapLayerInputs,
  runtimeProviderService,
} from "@lando/engine/runtime/bootstrap-layer-support";
import * as BuildOrchestratorLayer from "@lando/engine/services/build-orchestrator";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import * as AppPlanSanitizerLayer from "@lando/engine/subsystems/host-proxy/plan-sanitizer-live";
import * as RouterServiceRegistryLayer from "@lando/engine/subsystems/proxy/registry";
import * as ProviderUrlScanner from "@lando/engine/subsystems/scanner/live";
import * as SshServiceRegistryLayer from "@lando/engine/subsystems/ssh/registry";
import { mapFailures } from "@lando/sdk/command-result";
import { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { EventService, RuntimeProvider } from "@lando/sdk/services";
import { Context, Layer } from "effect";
import { BUILT_IN_COMMAND_IDS } from "../../cli/generated/command-ids.ts";
import { buildSourceStoreLayer } from "../engine-composition.ts";
import { makeCommandsBootstrapBaseLayer } from "./commands.ts";
import type { MinimalBootstrapLayerInputs } from "./minimal.ts";
import { makePluginsBootstrapBaseLayer } from "./plugins.ts";

export const makeProviderInventoryLayer = (inputs: MinimalBootstrapLayerInputs) => {
  if (inputs.runtimeProviderRegistry !== undefined) return inputs.runtimeProviderRegistry;
  const plugins = makePluginsBootstrapBaseLayer<never>({ ...inputs, pluginLayers: [] });
  return makeRuntimeProviderRegistryWithPrivateFileAccess(bundledPluginModules()).pipe(
    Layer.provide(
      Layer.mergeAll(
        plugins,
        AppPlanSanitizerLayer.layer,
        ContainerHelperAssetsLayer.layer.pipe(Layer.provide(plugins)),
      ),
    ),
  );
};

export const makeProviderBootstrapBaseLayer = (inputs: MinimalBootstrapLayerInputs) => {
  // Effect 4 memoizes leaf layers, not composite traversal. Share this dependency graph too.
  const commandsRuntimeLayer = Layer.suspend(() => makeCommandsBootstrapBaseLayer(inputs));
  const providerSupportLayer = Layer.mergeAll(
    AppPlanSanitizerLayer.layer,
    ContainerHelperAssetsLayer.layer.pipe(Layer.provide(commandsRuntimeLayer)),
  );
  const providerRegistryLayer =
    inputs.runtimeProviderRegistry ??
    makeRuntimeProviderRegistryWithPrivateFileAccess(bundledPluginModules()).pipe(
      Layer.provide(Layer.mergeAll(commandsRuntimeLayer, providerSupportLayer)),
    );

  const runtimeProviderLayer = Layer.succeed(RuntimeProvider, runtimeProviderService);
  const urlScannerLayer = ProviderUrlScanner.layer.pipe(
    Layer.provide(Layer.mergeAll(providerRegistryLayer, commandsRuntimeLayer)),
  );
  const certificateAuthorityResolverLayer =
    CertificateAuthorityResolverLayer.CertificateAuthorityResolver.layer.pipe(
      Layer.provide(commandsRuntimeLayer),
    );
  const localCaTrustLayer = LocalCaTrustLayer.layer.pipe(Layer.provide(commandsRuntimeLayer));
  const fileSyncResolverLayer = FileSyncResolverLayer.FileSyncResolver.layer.pipe(
    Layer.provide(commandsRuntimeLayer),
  );

  const globalAppServiceLayer = GlobalAppServiceLayer.layer.pipe(Layer.provide(commandsRuntimeLayer));
  const baseProviderLayer = Layer.mergeAll(
    commandsRuntimeLayer,
    providerSupportLayer,
    runtimeProviderLayer,
    PlannedServiceReadiness.layer,
    certificateAuthorityResolverLayer,
    localCaTrustLayer,
    fileSyncResolverLayer,
    urlScannerLayer,
    BunDataMover.layerWithPrivateFileAccess.pipe(
      Layer.provide(Layer.mergeAll(providerRegistryLayer, commandsRuntimeLayer)),
    ),
    providerRegistryLayer,
    globalAppServiceLayer,
  );
  const appPlannerLayer = AppPlannerLayer.layer.pipe(Layer.provide(baseProviderLayer));
  const buildOrchestratorLayer = BuildOrchestratorLayer.layer.pipe(
    Layer.provide(buildSourceStoreLayer),
    Layer.provide(baseProviderLayer),
  );
  const globalAppRuntimeLayer = GlobalAppRuntimeLayer.layer.pipe(
    Layer.provide(Layer.mergeAll(baseProviderLayer, appPlannerLayer, buildOrchestratorLayer)),
  );
  const routerRegistryLayer = Layer.fromBuildMemo((memoMap, scope) =>
    Layer.buildWithMemoMap(
      RouterServiceRegistryLayer.RouterServiceRegistry.layerWith(bundledPluginModules()).pipe(
        Layer.provide(Layer.mergeAll(baseProviderLayer, globalAppRuntimeLayer)),
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
  const routerServiceLayer = Layer.fromBuildMemo((memoMap, scope) =>
    Layer.buildWithMemoMap(
      RouterServiceRegistryLayer.layerSelected.pipe(
        Layer.provide(Layer.mergeAll(baseProviderLayer, globalAppRuntimeLayer, routerRegistryLayer)),
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
  const sshRegistryLayer = Layer.fromBuildMemo((memoMap, scope) =>
    Layer.buildWithMemoMap(
      SshServiceRegistryLayer.SshServiceRegistry.layerWith(bundledPluginModules()).pipe(
        Layer.provide(Layer.mergeAll(baseProviderLayer, globalAppRuntimeLayer)),
      ),
      memoMap,
      scope,
    ).pipe(
      mapFailures((cause) =>
        cause instanceof ConfigError
          ? cause
          : new LandoRuntimeBootstrapError({
              message: cause instanceof Error ? cause.message : "SshService bootstrap failed.",
              stage: "provider",
              cause,
              remediation:
                "Check the SSH-service plugin sshServices declaration and exported service ids before retrying.",
            }),
      ),
    ),
  );
  const sshServiceLayer = Layer.fromBuildMemo((memoMap, scope) =>
    Layer.buildWithMemoMap(
      SshServiceRegistryLayer.layerSelected.pipe(
        Layer.provide(Layer.mergeAll(baseProviderLayer, globalAppRuntimeLayer, sshRegistryLayer)),
      ),
      memoMap,
      scope,
    ).pipe(
      mapFailures((cause) =>
        cause instanceof ConfigError
          ? cause
          : new LandoRuntimeBootstrapError({
              message: cause instanceof Error ? cause.message : "SshService bootstrap failed.",
              stage: "provider",
              cause,
              remediation:
                "Repair the selected SSH-service plugin exported SshService layer and agent setup before retrying.",
            }),
      ),
    ),
  );

  return Layer.mergeAll(
    baseProviderLayer,
    appPlannerLayer,
    buildOrchestratorLayer,
    globalAppRuntimeLayer,
    routerRegistryLayer,
    routerServiceLayer,
    sshRegistryLayer,
    sshServiceLayer,
  ).pipe(Layer.tap((context) => inputs.lifecycle.complete("provider", Context.get(context, EventService))));
};

export const makeProviderBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapBaseLayer(inputs);
  const subscriberRuntimeLayer = SubscriberRuntimeLayer.layerWithPrivateFileAccess(
    bundledPluginModules(),
    BUILT_IN_COMMAND_IDS,
  ).pipe(Layer.provide(providerBase));
  return Layer.merge(providerBase, subscriberRuntimeLayer);
};
