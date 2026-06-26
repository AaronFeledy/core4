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
import { RuntimeProviderRegistryLive } from "../../../providers/registry.ts";
import { RedactionServiceLive } from "../../../redaction/service.ts";
import { ConfigServiceLive } from "../../../services/config.ts";
import { EventServiceLive } from "../../../services/event-service.ts";
import { FileSystemLive } from "../../../services/file-system.ts";
import { SecretStoreLive } from "../../../services/secret-store.ts";
import { type BootstrapLayerInputs, runtimeProviderService } from "../../bootstrap-layer-support.ts";
import { makePluginsBootstrapLayer } from "./plugins.ts";

export const makeProviderBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const pluginsRuntimeLive = makePluginsBootstrapLayer(inputs);
  const providerRegistryLive = RuntimeProviderRegistryLive.pipe(
    Layer.provide(Layer.mergeAll(pluginsRuntimeLive, EventServiceLive)),
  );

  return Layer.mergeAll(
    pluginsRuntimeLive,
    EventServiceLive,
    Layer.succeed(RuntimeProvider, runtimeProviderService),
    DataMoverLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RuntimeProvider, runtimeProviderService),
          EventServiceLive,
          RedactionServiceLive.pipe(Layer.provide(SecretStoreLive)),
        ),
      ),
    ),
    providerRegistryLive,
    GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
  );
};
