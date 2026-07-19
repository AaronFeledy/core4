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

import { RuntimeProvider } from "@lando/sdk/services";
import { DataMoverLive } from "../../../data-mover/service.ts";
import { GlobalAppServiceLive } from "../../../global-app/service.ts";
import { makeSubscriberRuntimeLive } from "../../../lifecycle/subscribers.ts";
import { RuntimeProviderRegistryLive } from "../../../providers/registry.ts";
import { ConfigServiceLive } from "../../../services/config.ts";
import { FileSystemLive } from "../../../services/file-system.ts";
import { UrlScannerLive } from "../../../subsystems/scanner/live.ts";
import { type BootstrapLayerInputs, runtimeProviderService } from "../../bootstrap-layer-support.ts";
import { makeCommandsBootstrapBaseLayer } from "./commands.ts";

export const makeProviderBootstrapBaseLayer = (inputs: BootstrapLayerInputs) => {
  const pluginsRuntimeLive = makeCommandsBootstrapBaseLayer(inputs);
  const providerRegistryLive = RuntimeProviderRegistryLive.pipe(Layer.provide(pluginsRuntimeLive));

  const runtimeProviderLive = Layer.succeed(RuntimeProvider, runtimeProviderService);
  const urlScannerLive = UrlScannerLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeProviderLive, pluginsRuntimeLive)),
  );

  return Layer.mergeAll(
    pluginsRuntimeLive,
    runtimeProviderLive,
    urlScannerLive,
    DataMoverLive.pipe(Layer.provide(Layer.mergeAll(runtimeProviderLive, pluginsRuntimeLive))),
    providerRegistryLive,
    GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
  );
};

export const makeProviderBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const providerBase = makeProviderBootstrapBaseLayer(inputs);
  const subscriberRuntimeLive = makeSubscriberRuntimeLive().pipe(Layer.provide(providerBase));
  return Layer.merge(providerBase, subscriberRuntimeLive);
};
