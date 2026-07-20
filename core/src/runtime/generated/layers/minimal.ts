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

import { EventService, PathsService, Renderer } from "@lando/sdk/services";
import { CacheServiceLive } from "../../../cache/service.ts";
import { makeLandoPaths } from "../../../config/paths.ts";
import { DeprecationServiceLive } from "../../../deprecation/service.ts";
import { DeprecationTelemetryLive } from "../../../deprecation/telemetry.ts";
import { DownloaderLive } from "../../../downloader/service.ts";
import { HttpClientLive } from "../../../http-client/live.ts";
import { InteractionServiceLive } from "../../../interaction/service.ts";
import { LoggerLive } from "../../../logging/service.ts";
import { ManagedFileServiceLive } from "../../../managed-file/service.ts";
import { PluginTrustStoreLive } from "../../../plugins/trust-store.ts";
import { RedactionServiceLive } from "../../../redaction/service.ts";
import { ConfigServiceLive } from "../../../services/config.ts";
import { makeEventRuntimeLive } from "../../../services/event-service.ts";
import { FileSystemLive } from "../../../services/file-system.ts";
import { PrivilegeServiceLive } from "../../../services/privilege.ts";
import { ProcessRunnerLive } from "../../../services/process-runner.ts";
import { SecretStoreLive } from "../../../services/secret-store.ts";
import { StateStoreLive } from "../../../state/service.ts";
import { makeTelemetryLayer } from "../../../telemetry/service.ts";
import { type BootstrapLayerInputs, makeLibraryRenderer } from "../../bootstrap-layer-support.ts";

export const makeMinimalBootstrapLayer = (inputs: BootstrapLayerInputs) => {
  const telemetryLive = makeTelemetryLayer(inputs.telemetryEnabled);
  const redactionLive = RedactionServiceLive.pipe(Layer.provide(SecretStoreLive));
  const eventServiceLive = makeEventRuntimeLive().pipe(
    Layer.provide(Layer.mergeAll(ConfigServiceLive, redactionLive)),
    Layer.tap((context) => inputs.lifecycle.useBaseEventService(Context.get(context, EventService))),
  );
  const httpClientLive = HttpClientLive.pipe(
    Layer.provide(Layer.mergeAll(ConfigServiceLive, eventServiceLive)),
  );

  const minimalRuntimeLive = Layer.mergeAll(
    LoggerLive({ mode: inputs.loggerMode }),
    Layer.succeed(Renderer, makeLibraryRenderer(inputs.rendererMode)),
    Layer.succeed(PathsService, makeLandoPaths(inputs.rootOverrides)),
    telemetryLive,
    ConfigServiceLive,
    eventServiceLive,
    DeprecationServiceLive.pipe(Layer.provide(eventServiceLive)),
    DeprecationTelemetryLive.pipe(Layer.provide(Layer.mergeAll(eventServiceLive, telemetryLive))),
    PluginTrustStoreLive.pipe(Layer.provide(ConfigServiceLive)),
    CacheServiceLive,
    FileSystemLive,
    ProcessRunnerLive,
    PrivilegeServiceLive,
    SecretStoreLive,
    StateStoreLive,
    redactionLive,
    Layer.suspend(() => ManagedFileServiceLive).pipe(
      Layer.provide(Layer.mergeAll(eventServiceLive, redactionLive)),
    ),
    Layer.suspend(() => InteractionServiceLive),
    httpClientLive,
    DownloaderLive.pipe(Layer.provide(httpClientLive)),
  );
  return minimalRuntimeLive.pipe(
    Layer.tap((context) => inputs.lifecycle.complete("minimal", Context.get(context, EventService))),
  );
};
