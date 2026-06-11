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

import { Renderer, Telemetry } from "@lando/sdk/services";
import { CacheServiceLive } from "../../../cache/service.ts";
import { DeprecationServiceLive } from "../../../deprecation/service.ts";
import { DeprecationTelemetryLive } from "../../../deprecation/telemetry.ts";
import { LoggerLive } from "../../../logging/service.ts";
import { PluginTrustStoreLive } from "../../../plugins/trust-store.ts";
import { ConfigServiceLive } from "../../../services/config.ts";
import { EventServiceLive } from "../../../services/event-service.ts";
import { FileSystemLive } from "../../../services/file-system.ts";
import { PrivilegeServiceLive } from "../../../services/privilege.ts";
import { SecretStoreLive } from "../../../services/secret-store.ts";
import {
  type BootstrapLayerInputs,
  makeLibraryRenderer,
  makeLibraryTelemetry,
} from "../../bootstrap-layer-support.ts";

export const makeMinimalBootstrapLayer = (inputs: BootstrapLayerInputs) =>
  Layer.mergeAll(
    LoggerLive({ mode: inputs.loggerMode }),
    Layer.succeed(Renderer, makeLibraryRenderer(inputs.rendererMode)),
    Layer.succeed(Telemetry, makeLibraryTelemetry(inputs.telemetryEnabled)),
    ConfigServiceLive,
    EventServiceLive,
    DeprecationServiceLive.pipe(Layer.provide(EventServiceLive)),
    DeprecationTelemetryLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          EventServiceLive,
          Layer.succeed(Telemetry, makeLibraryTelemetry(inputs.telemetryEnabled)),
        ),
      ),
    ),
    PluginTrustStoreLive.pipe(Layer.provide(ConfigServiceLive)),
    CacheServiceLive,
    FileSystemLive,
    PrivilegeServiceLive,
    SecretStoreLive,
  );
