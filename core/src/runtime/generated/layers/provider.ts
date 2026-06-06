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

import { RuntimeProvider } from "@lando/sdk/services";
import { GlobalAppServiceLive } from "../../../global-app/service.ts";
import { makePluginRegistryLive } from "../../../plugins/registry.ts";
import { RuntimeProviderRegistryLive } from "../../../providers/registry.ts";
import { ConfigServiceLive } from "../../../services/config.ts";
import { EventServiceLive } from "../../../services/event-service.ts";
import { FileSystemLive } from "../../../services/file-system.ts";
import { type BootstrapLayerInputs, runtimeProviderService } from "../../bootstrap-layer-support.ts";
import { makeMinimalBootstrapLayer } from "./minimal.ts";

export const makeProviderBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const minimalRuntimeLive = makeMinimalBootstrapLayer(inputs);
  const pluginRegistryLive = makePluginRegistryLive(inputs.pluginDiscovery).pipe(
    Layer.provide(minimalRuntimeLive),
  );
  const providerRegistryLive = RuntimeProviderRegistryLive.pipe(
    Layer.provide(Layer.mergeAll(minimalRuntimeLive, pluginRegistryLive, EventServiceLive)),
  );

  return Layer.mergeAll(
    minimalRuntimeLive,
    EventServiceLive,
    pluginRegistryLive,
    Layer.succeed(RuntimeProvider, runtimeProviderService),
    providerRegistryLive,
    GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
  );
};
