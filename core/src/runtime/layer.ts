/**
 * Runtime composition and `makeLandoRuntime` factory.
 *
 * The composed `LandoRuntimeLive` layer is built once at the host boundary
 * and then provided to the program. Intermediate layer composition stays out
 * of core except in tests.
 *
 * Factory behavior:
 * - Returns one `Layer` that satisfies the default service tags.
 * - Validates options with Effect Schema and can fail with
 *   `LandoRuntimeBootstrapError`.
 * - Is safe to call multiple times in one process; each call gets isolated
 *   caches, plugin registry, and event bus state.
 * - Does not mutate process-global state unless `installSignalHandlers: true`.
 * - Runs the requested bootstrap sequence.
 * - Keeps resource ownership in the layer's outer scope.
 */
import { Effect, Either, Layer, Schema } from "effect";

import { type ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type {
  AppPlanSanitizer,
  AppPlanner,
  BuildOrchestrator,
  CacheService,
  CommandRegistry,
  ConfigService,
  DataMover,
  Downloader,
  EventService,
  FileSyncEngine,
  FileSystem,
  GlobalAppService,
  HttpClient,
  InteractionService,
  LandofileService,
  LogFileHelperAssets,
  Logger,
  ManagedFileService,
  PathsService,
  PluginRegistry,
  PluginTrustStore,
  PrivilegeService,
  ProcessRunner,
  ProxyService,
  Renderer,
  RootOverrides,
  RuntimeProvider,
  RuntimeProviderRegistry,
  ScratchAppService,
  SecretStore,
  ShellRunner,
  StateStore,
  Telemetry,
  ToolingEngine,
} from "@lando/sdk/services";

import { bundledPluginModules } from "@lando/engine/composition";
import type { LoggerMode } from "@lando/engine/logging/service";
import type { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
import type { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import type { RedactionService } from "@lando/engine/redaction/service";
import type { BootstrapLevel } from "@lando/engine/runtime/bootstrap";
import {
  type BootstrapLifecycleTracker,
  makeBootstrapLifecycleTracker,
} from "@lando/engine/runtime/bootstrap-lifecycle";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import type { HostMaintenanceRegistry } from "@lando/engine/runtime/host-maintenance";
import { installSignalHandlers } from "@lando/engine/runtime/interrupt";
import {
  LandoRuntimeOptions,
  type LibraryRendererMode,
  type NormalizedPluginPolicy,
  bootstrapError,
  collectEmbeddingPluginLayers,
  normalizeLibraryRendererMode,
  normalizePluginPolicy,
  rootOverridesFromConfig,
} from "@lando/engine/runtime/runtime-options";
import type { EventDeliveryMetrics } from "@lando/engine/services/event-service";
import { InteractionService as InteractionServiceTag } from "@lando/sdk/services";

import { makeDefaultResolveInteractionDriver, makeInteractionService } from "../interaction/service";
import { makeGeneratedBootstrapLayer, mergeRuntimeWithHostLayers } from "./generated/layers/index";
import "./engine-composition";

export { LandoRuntimeOptions } from "@lando/engine/runtime/runtime-options";

type MinimalRuntimeServices =
  | Logger
  | Renderer
  | Telemetry
  | ConfigService
  | EventService
  | EventDeliveryMetrics
  | PathsService
  | FileSystem
  | CacheService
  | ManagedFileService
  | InteractionService
  | PluginTrustStore
  | PrivilegeService
  | ProcessRunner
  | RedactionService
  | SecretStore
  | StateStore
  | HttpClient
  | Downloader
  | HostMaintenanceRegistry;
type PluginRuntimeServices = MinimalRuntimeServices | PluginRegistry | PluginContributionGraph;
type CommandRuntimeServices = PluginRuntimeServices | LandofileService | CommandRegistry;
type ToolingRuntimeServices = CommandRuntimeServices;
type ProviderRuntimeServices =
  | CommandRuntimeServices
  | RuntimeProvider
  | RuntimeProviderRegistry
  | CertificateAuthorityResolver
  | DataMover
  | AppPlanSanitizer
  | LogFileHelperAssets
  | GlobalAppService;
type GlobalRuntimeServices = ProviderRuntimeServices | AppPlanner | BuildOrchestrator;
type ScratchRuntimeServices =
  | ProviderRuntimeServices
  | LandofileService
  | AppPlanner
  | BuildOrchestrator
  | ProxyService
  | ScratchAppService;
export type AppRuntimeServices =
  | ProviderRuntimeServices
  | BuildOrchestrator
  | LandofileService
  | CommandRegistry
  | AppPlanner
  | EventService
  | ToolingEngine
  | ShellRunner
  | FileSyncEngine
  | ProxyService
  | RuntimeCwd;
type RuntimeLayer =
  | Layer.Layer<never>
  | Layer.Layer<MinimalRuntimeServices>
  | Layer.Layer<MinimalRuntimeServices, LandoRuntimeBootstrapError>
  | Layer.Layer<PluginRuntimeServices>
  | Layer.Layer<PluginRuntimeServices, LandoRuntimeBootstrapError>
  | Layer.Layer<CommandRuntimeServices>
  | Layer.Layer<CommandRuntimeServices, ConfigError | LandoRuntimeBootstrapError>
  | Layer.Layer<ProviderRuntimeServices>
  | Layer.Layer<ProviderRuntimeServices, ConfigError | LandoRuntimeBootstrapError>
  | Layer.Layer<GlobalRuntimeServices>
  | Layer.Layer<GlobalRuntimeServices, ConfigError | LandoRuntimeBootstrapError>
  | Layer.Layer<ScratchRuntimeServices>
  | Layer.Layer<ScratchRuntimeServices, ConfigError | LandoRuntimeBootstrapError>
  | Layer.Layer<AppRuntimeServices>
  | Layer.Layer<AppRuntimeServices, ConfigError | LandoRuntimeBootstrapError>
  | Layer.Layer<unknown, ConfigError | LandoRuntimeBootstrapError>;

const runtimeLayerFor = (
  bootstrap: BootstrapLevel,
  loggerMode: LoggerMode,
  rendererMode: LibraryRendererMode,
  telemetryEnabled: boolean,
  pluginPolicy: NormalizedPluginPolicy,
  rootOverrides: RootOverrides,
  lifecycle: BootstrapLifecycleTracker,
  pluginLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>,
  cwd: string,
): RuntimeLayer =>
  makeGeneratedBootstrapLayer(bootstrap, {
    lifecycle,
    loggerMode,
    rendererMode,
    telemetryEnabled,
    pluginDiscovery: pluginPolicy.discovery,
    pluginLayers,
    pluginManifests: pluginPolicy.manifests,
    externalImports: pluginPolicy.externalImports,
    cwd,
    rootOverrides,
  }) as RuntimeLayer;

const signalHandlersLayer = Layer.scopedDiscard(
  Effect.withFiberRuntime((fiber) => installSignalHandlers({ fiber })),
);

/**
 * `makeLandoRuntime`.
 *
 * Builds the runtime layer for the requested bootstrap depth. This factory
 * owns composition and option validation only.
 */
type LandoRuntimeOptionsFor<TBootstrap extends BootstrapLevel> = LandoRuntimeOptions & {
  readonly bootstrap: TBootstrap;
};

export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"minimal">,
): Layer.Layer<MinimalRuntimeServices, LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"plugins">,
): Layer.Layer<PluginRuntimeServices, LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"commands">,
): Layer.Layer<CommandRuntimeServices, ConfigError | LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"tooling">,
): Layer.Layer<ToolingRuntimeServices, ConfigError | LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"provider">,
): Layer.Layer<ProviderRuntimeServices, ConfigError | LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"global">,
): Layer.Layer<GlobalRuntimeServices, ConfigError | LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"scratch">,
): Layer.Layer<ScratchRuntimeServices, ConfigError | LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"app">,
): Layer.Layer<AppRuntimeServices, ConfigError | LandoRuntimeBootstrapError>;
export function makeLandoRuntime(options: unknown): RuntimeLayer;
export function makeLandoRuntime(options: unknown): RuntimeLayer {
  const decoded = Schema.decodeUnknownEither(LandoRuntimeOptions)(options);

  if (Either.isLeft(decoded)) {
    return Layer.fail(bootstrapError("Invalid Lando runtime options.", decoded.left));
  }

  const pluginPolicy = normalizePluginPolicy(decoded.right.plugins);
  if (pluginPolicy.discovery.bundled && bundledPluginModules().length === 0) {
    return Layer.fail(
      new LandoRuntimeBootstrapError({
        message:
          "Bundled plugin discovery requires importing @lando/core/bundled-plugins before constructing the runtime.",
        stage: "plugins",
      }),
    );
  }
  const capturedCwd = decoded.right.cwd ?? process.cwd();
  const lifecycle = makeBootstrapLifecycleTracker();
  const hostLayersResult = collectEmbeddingPluginLayers(pluginPolicy.layers);

  if (Either.isLeft(hostLayersResult)) {
    return Layer.fail(hostLayersResult.left);
  }
  const bootstrap = decoded.right.bootstrap ?? "app";
  const baseLayer = runtimeLayerFor(
    bootstrap,
    decoded.right.logger === "pretty" ? "pretty" : "silent",
    normalizeLibraryRendererMode(decoded.right.renderer ?? decoded.right.config?.renderer),
    decoded.right.telemetry ?? decoded.right.config?.telemetry?.enabled ?? false,
    pluginPolicy,
    rootOverridesFromConfig(decoded.right.config),
    lifecycle,
    hostLayersResult.right,
    capturedCwd,
  );

  // Library mode defaults prompts to non-interactive; the option overrides the
  // bootstrap default mode and is itself overridden by an explicit host
  // InteractionService in plugins.layers (merged last, so it wins).
  const interactionMode = decoded.right.interaction ?? "non-interactive";
  const interactionOverride = Layer.succeed(
    InteractionServiceTag,
    makeInteractionService({
      defaultMode: interactionMode,
      resolveDriver: makeDefaultResolveInteractionDriver(),
    }),
  ) as unknown as Layer.Layer<unknown, unknown, unknown>;

  const baseHostLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>> = [
    Layer.succeed(RuntimeCwd, capturedCwd) as unknown as Layer.Layer<unknown, unknown, unknown>,
    interactionOverride,
    ...(bootstrap === "none" || bootstrap === "minimal" ? hostLayersResult.right : []),
  ];
  const hostLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>> =
    decoded.right.installSignalHandlers === true
      ? [...baseHostLayers, signalHandlersLayer as unknown as Layer.Layer<unknown, unknown, unknown>]
      : baseHostLayers;
  return mergeRuntimeWithHostLayers(
    baseLayer as unknown as Layer.Layer<unknown, unknown, unknown>,
    hostLayers,
    bootstrap,
    lifecycle,
  ) as RuntimeLayer;
}
