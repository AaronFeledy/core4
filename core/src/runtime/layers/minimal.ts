import * as AppCacheService from "@lando/engine/cache/service";

import { bundledPluginModules } from "@lando/engine/composition";
import * as DeprecationServiceLayer from "@lando/engine/deprecation/service";
import * as DeprecationTelemetry from "@lando/engine/deprecation/telemetry";
import * as LandoLogger from "@lando/engine/logging/service";
import * as PluginTrustStoreLayer from "@lando/engine/plugins/trust-store";
import {
  type BootstrapLayerInputs,
  makeLibraryRenderer,
} from "@lando/engine/runtime/bootstrap-layer-support";
import { makeHostMaintenanceRegistryLayer } from "@lando/engine/runtime/host-maintenance";
import * as LandoConfigService from "@lando/engine/services/config";
import * as EnvironmentValueResolverLayer from "@lando/engine/services/environment-value-resolver";
import * as LandoEventService from "@lando/engine/services/event-service";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as HostPrivilegeService from "@lando/engine/services/privilege";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import * as RoutedSecretStore from "@lando/engine/services/secret-store-registry";
import * as BunShellRunner from "@lando/engine/services/shell-runner";
import { CORE_VERSION } from "@lando/engine/version";
import * as LandoHttpClient from "@lando/http-client";
import * as VerifiedDownloader from "@lando/http-client/downloader";
import * as ManagedFileLayer from "@lando/managed-file/service";
import * as ManagedFileTransactionGuardLayer from "@lando/managed-file/transaction-guard";
import { RedactionService } from "@lando/redaction/service";
import { EventService, Renderer } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import * as StateStoreLayer from "@lando/state-store/service";
import * as TelemetryLayer from "@lando/telemetry/service";
import { Context, Layer } from "effect";
import { finishCommandProgress } from "../../cli/command-progress.ts";
import { makeProcessShellReplIO } from "../../cli/host-shell-terminal.ts";
import { hostHasPromptTerminal } from "../../cli/prompt-terminal.ts";
import * as InteractionServiceLayer from "../../interaction/service.ts";
import { makeNoneBootstrapLayer } from "./none.ts";

export const makeMinimalBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const noneRuntimeLayer = makeNoneBootstrapLayer(inputs);
  const telemetryLayer = TelemetryLayer.layer(inputs.telemetryEnabled);
  const configLayer = LandoConfigService.layerFromSources.pipe(Layer.provide(noneRuntimeLayer));
  const pathsLayer = configLayer;
  const secretStoreLayer = RoutedSecretStore.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RoutedSecretStore.SecretStoreRegistry.layer(bundledPluginModules()),
        configLayer,
        BunProcessRunner.layer,
        BunFileSystem.layer,
        pathsLayer,
      ),
    ),
  );
  const redactionLayer = RedactionService.layer;
  const privateFileAccessLayer = PrivateFileAccessService.layer;
  const eventServiceLayer = LandoEventService.layerRuntimeWithConfig().pipe(
    Layer.provide(Layer.mergeAll(configLayer, redactionLayer)),
    Layer.tap((context) => inputs.lifecycle.useBaseEventService(Context.get(context, EventService))),
  );
  const httpClientLayer = LandoHttpClient.layerWith({
    env: inputs.configInputs.sources.env ? inputs.configInputs.env : {},
  }).pipe(Layer.provide(Layer.mergeAll(configLayer, eventServiceLayer)));

  const minimalRuntimeLayer = Layer.mergeAll(
    noneRuntimeLayer,
    LandoLogger.layer({
      mode: inputs.loggerMode,
      logLevel: inputs.logLevel,
      structured: inputs.structured,
      ...(inputs.writeDiagnosticLine === undefined ? {} : { writeLine: inputs.writeDiagnosticLine }),
      ...(inputs.stderrIsTTY === undefined ? {} : { stderrIsTTY: inputs.stderrIsTTY }),
    }),
    Layer.succeed(Renderer, makeLibraryRenderer(inputs.rendererMode)),
    pathsLayer,
    telemetryLayer,
    privateFileAccessLayer,
    configLayer,
    eventServiceLayer,
    DeprecationServiceLayer.layer.pipe(Layer.provide(eventServiceLayer)),
    DeprecationTelemetry.layer.pipe(Layer.provide(Layer.mergeAll(eventServiceLayer, telemetryLayer))),
    PluginTrustStoreLayer.layer.pipe(Layer.provide(configLayer)),
    makeHostMaintenanceRegistryLayer(bundledPluginModules()),
    AppCacheService.layerWithPrivateFileAccess.pipe(Layer.provide(privateFileAccessLayer)),
    BunFileSystem.layer,
    BunProcessRunner.layer,
    BunShellRunner.layerWithPrivateFileAccess(makeProcessShellReplIO).pipe(
      Layer.provide(Layer.mergeAll(privateFileAccessLayer, BunProcessRunner.layer)),
    ),
    HostPrivilegeService.layer({
      prepareTerminal: finishCommandProgress(),
      hasTerminal: hostHasPromptTerminal,
    }).pipe(Layer.provide(BunProcessRunner.layer)),
    secretStoreLayer,
    StateStoreLayer.layerWithPrivateFileAccessOptions({ writer: CORE_VERSION }).pipe(
      Layer.provide(Layer.mergeAll(privateFileAccessLayer, configLayer)),
    ),
    ManagedFileTransactionGuardLayer.layerWithPrivateFileAccess.pipe(
      Layer.provide(Layer.mergeAll(privateFileAccessLayer, configLayer)),
    ),
    redactionLayer,
    EnvironmentValueResolverLayer.layer.pipe(Layer.provide(Layer.mergeAll(secretStoreLayer, redactionLayer))),
    Layer.suspend(() => ManagedFileLayer.layerServicesWithPrivateFileAccess).pipe(
      Layer.provide(Layer.mergeAll(eventServiceLayer, redactionLayer, privateFileAccessLayer, configLayer)),
    ),
    Layer.suspend(() => InteractionServiceLayer.layer),
    httpClientLayer,
    VerifiedDownloader.layer.pipe(Layer.provide(Layer.mergeAll(httpClientLayer, eventServiceLayer))),
  );
  return minimalRuntimeLayer.pipe(
    Layer.tap((context) => inputs.lifecycle.complete("minimal", Context.get(context, EventService))),
  );
};

export type MinimalBootstrapServices = Layer.Success<ReturnType<typeof makeMinimalBootstrapLayer>>;

/**
 * Inputs for the tiers above minimal. `minimalContext` supplies an already-built minimal tier, so
 * an app contribution generation builds its plugin-dependent tiers over the host's event bus,
 * config, and redaction services instead of constructing a second set.
 */
export interface MinimalBootstrapLayerInputs extends BootstrapLayerInputs {
  readonly minimalContext?: Context.Context<MinimalBootstrapServices> | undefined;
}

export const minimalBootstrapLayerFor = (
  inputs: MinimalBootstrapLayerInputs,
): Layer.Layer<MinimalBootstrapServices, Layer.Error<ReturnType<typeof makeMinimalBootstrapLayer>>> =>
  inputs.minimalContext === undefined
    ? makeMinimalBootstrapLayer(inputs)
    : Layer.succeedContext(inputs.minimalContext);
