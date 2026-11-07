import { Effect, Layer, Result, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";

import { type ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { LogLevel } from "@lando/sdk/schema";
import type {
  AppPlanSanitizer,
  AppPlanner,
  BuildOrchestrator,
  CacheService,
  CommandRegistry,
  ConfigService,
  ConfigTranslatorRegistry,
  ContainerHelperAssets,
  DataMover,
  Downloader,
  EnvironmentValueResolver,
  EventService,
  FileSystem,
  GlobalAppService,
  InteractionService,
  LandofileService,
  Logger,
  ManagedFileService,
  ManagedFileTransactionGuard,
  PathsService,
  PluginRegistry,
  PluginTrustStore,
  PrivilegeService,
  ProcessRunner,
  Renderer,
  RouterService,
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
import type { FileSyncResolver } from "@lando/engine/plugins/file-sync-resolver";
import type { BootstrapLevel } from "@lando/engine/runtime/bootstrap";
import {
  type BootstrapLifecycleTracker,
  makeBootstrapLifecycleTracker,
} from "@lando/engine/runtime/bootstrap-lifecycle";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import type { HostMaintenanceRegistry } from "@lando/engine/runtime/host-maintenance";
import { installSignalHandlers } from "@lando/engine/runtime/interrupt";
import type {
  RuntimeLayer as EngineRuntimeLayer,
  RuntimeLayerFactory,
} from "@lando/engine/runtime/runtime-layer-factory";
import {
  LandoRuntimeOptions,
  type LibraryRendererMode,
  type NormalizedPluginPolicy,
  bootstrapError,
  collectEmbeddingPluginLayers,
  normalizeLibraryRendererMode,
  normalizePluginPolicy,
  resolveRuntimeLogging,
  rootOverridesFromConfig,
} from "@lando/engine/runtime/runtime-options";
import type { ScratchResourceScanner } from "@lando/engine/scratch-app/scanner";
import type { GlobalConfigSnapshot, GlobalConfigSources } from "@lando/engine/services/config";
import type { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import type { EventDeliveryMetrics } from "@lando/engine/services/event-service";
import type { EventDispatchControl } from "@lando/engine/services/event-service";
import type { ManagedFileServiceFactory } from "@lando/managed-file/service";
import type { RedactionService } from "@lando/redaction/service";
import { InteractionService as InteractionServiceTag } from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import type { BuiltInCommandCatalog } from "../cli/built-in-command-catalog-service";
import { makeDefaultResolveInteractionDriver, makeInteractionService } from "../interaction/service";
import { makeGeneratedBootstrapLayer, mergeRuntimeWithHostLayers } from "./generated/layers/index";
import "./engine-composition";
import {
  CliInvocation,
  type CliInvocationContext,
  processInvocationContext,
  processInvocationDefaults,
} from "./invocation-context";

export { LandoRuntimeOptions } from "@lando/engine/runtime/runtime-options";

type NoneRuntimeServices = RuntimeLayerFactory | GlobalConfigSources;
type MinimalRuntimeServices =
  | GlobalConfigSnapshot
  | NoneRuntimeServices
  | Logger
  | Renderer
  | Telemetry
  | ConfigService
  | EventService
  | EventDeliveryMetrics
  | EventDispatchControl
  | PathsService
  | FileSystem
  | CacheService
  | ManagedFileService
  | ManagedFileServiceFactory
  | ManagedFileTransactionGuard
  | InteractionService
  | PluginTrustStore
  | PrivilegeService
  | ProcessRunner
  | ShellRunner
  | PrivateFileAccessService
  | RedactionService
  | SecretStore
  | EnvironmentValueResolver
  | StateStore
  | HttpClient.HttpClient
  | Downloader
  | HostMaintenanceRegistry;
type PluginRuntimeServices =
  | MinimalRuntimeServices
  | PluginRegistry
  | ConfigTranslatorRegistry
  | PluginContributionGraph
  | BuiltInCommandCatalog;
type CommandRuntimeServices = PluginRuntimeServices | LandofileService | CommandRegistry;
type ToolingRuntimeServices = CommandRuntimeServices;
type ProviderRuntimeServices =
  | CommandRuntimeServices
  | RuntimeProvider
  | RuntimeProviderRegistry
  | CertificateAuthorityResolver
  | FileSyncResolver
  | DataMover
  | AppPlanSanitizer
  | ContainerHelperAssets
  | GlobalAppService;
type GlobalRuntimeServices = ProviderRuntimeServices | AppPlanner | BuildOrchestrator | RouterService;
type ScratchRuntimeServices =
  | ProviderRuntimeServices
  | LandofileService
  | AppPlanner
  | BuildOrchestrator
  | RouterService
  | ScratchResourceScanner
  | ScratchAppService;
export type AppRuntimeServices =
  | ProviderRuntimeServices
  | BuildOrchestrator
  | LandofileService
  | CommandRegistry
  | AppPlanner
  | EventService
  | ToolingEngine
  | RouterService
  | RuntimeCwd
  | EventCommandExecutor;
type RuntimeLayer =
  | Layer.Layer<never, ConfigError | LandoRuntimeBootstrapError>
  | Layer.Layer<never>
  | Layer.Layer<never, LandoRuntimeBootstrapError>
  | Layer.Layer<NoneRuntimeServices>
  | Layer.Layer<MinimalRuntimeServices>
  | Layer.Layer<MinimalRuntimeServices, ConfigError | LandoRuntimeBootstrapError>
  | Layer.Layer<PluginRuntimeServices>
  | Layer.Layer<PluginRuntimeServices, ConfigError | LandoRuntimeBootstrapError>
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
  logLevel: LogLevel | undefined,
  structured: boolean,
  rendererMode: LibraryRendererMode,
  telemetryEnabled: boolean,
  pluginPolicy: NormalizedPluginPolicy,
  lifecycle: BootstrapLifecycleTracker,
  pluginLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>,
  cwd: string,
  configInputs: GlobalConfigSources["Service"],
  invocation: CliInvocationContext,
): RuntimeLayer => {
  const runtimeProviderRegistry = invocation.providerRegistry;
  return makeGeneratedBootstrapLayer(bootstrap, {
    runtimeLayerFactory: { make: makeLandoRuntime },
    lifecycle,
    loggerMode,
    logLevel,
    structured,
    writeDiagnosticLine: (line) => {
      invocation.io.writeStderr(`${line}\n`);
    },
    stderrIsTTY: invocation.io.isTTY === true,
    rendererMode,
    telemetryEnabled,
    pluginDiscovery: pluginPolicy.discovery,
    pluginLayers,
    ...(runtimeProviderRegistry === undefined ? {} : { runtimeProviderRegistry }),
    pluginManifests: pluginPolicy.manifests,
    externalImports: pluginPolicy.externalImports,
    cwd,
    configInputs,
  }) as RuntimeLayer;
};

const signalHandlersLayer = Layer.effectDiscard(
  Effect.withFiber((fiber) => installSignalHandlers({ fiber })),
);

type LandoRuntimeOptionsFor<TBootstrap extends BootstrapLevel> = LandoRuntimeOptions & {
  readonly bootstrap: TBootstrap;
};

export function makeLandoRuntime(options: LandoRuntimeOptionsFor<"none">): Layer.Layer<NoneRuntimeServices>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"minimal">,
): Layer.Layer<MinimalRuntimeServices, ConfigError | LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"plugins">,
): Layer.Layer<PluginRuntimeServices, ConfigError | LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"commands">,
): Layer.Layer<CommandRuntimeServices, ConfigError | LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"tooling">,
): Layer.Layer<ToolingRuntimeServices, ConfigError | LandoRuntimeBootstrapError>;
export function makeLandoRuntime(
  options: LandoRuntimeOptionsFor<"provider">,
  snapshot?: GlobalConfigSnapshot["Service"],
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
export function makeLandoRuntime(options: LandoRuntimeOptions): EngineRuntimeLayer;
export function makeLandoRuntime(options: unknown): RuntimeLayer;
export function makeLandoRuntime(options: unknown, snapshot?: GlobalConfigSnapshot["Service"]): RuntimeLayer {
  const host = processInvocationContext();
  return Layer.unwrap(
    Effect.map(CliInvocation, (invocation) =>
      buildLandoRuntime(options, snapshot, invocation === processInvocationDefaults ? host : invocation),
    ),
  );
}

function buildLandoRuntime(
  options: unknown,
  snapshot: GlobalConfigSnapshot["Service"] | undefined,
  invocation: CliInvocationContext,
): RuntimeLayer {
  const decoded = Schema.decodeUnknownResult(LandoRuntimeOptions)(options);

  if (Result.isFailure(decoded)) {
    return Layer.effectDiscard(
      Effect.fail(bootstrapError("Invalid Lando runtime options.", decoded.failure)),
    );
  }

  const pluginPolicy = normalizePluginPolicy(decoded.success.plugins);
  if (pluginPolicy.discovery.bundled && bundledPluginModules().length === 0) {
    return Layer.effectDiscard(
      Effect.fail(
        new LandoRuntimeBootstrapError({
          message:
            "Bundled plugin discovery requires importing @lando/core/bundled-plugins before constructing the runtime.",
          stage: "plugins",
          remediation:
            "Import `@lando/core/bundled-plugins` before constructing the runtime (or use the CLI entrypoint that loads bundled plugins).",
        }),
      ),
    );
  }
  const capturedCwd = decoded.success.cwd ?? invocation.cwd;
  const lifecycle = makeBootstrapLifecycleTracker();
  const hostLayersResult = collectEmbeddingPluginLayers([
    ...pluginPolicy.layers,
    ...(invocation.serviceLayers ?? []),
  ]);

  if (Result.isFailure(hostLayersResult)) {
    return Layer.effectDiscard(Effect.fail(hostLayersResult.failure));
  }
  const bootstrap = decoded.success.bootstrap ?? "app";
  const logging = resolveRuntimeLogging(decoded.success);
  const baseLayer = runtimeLayerFor(
    bootstrap,
    logging.loggerMode,
    logging.logLevel,
    logging.structured,
    normalizeLibraryRendererMode(decoded.success.renderer ?? decoded.success.config?.renderer),
    decoded.success.telemetry ?? decoded.success.config?.telemetry?.enabled ?? false,
    pluginPolicy,
    lifecycle,
    hostLayersResult.success,
    capturedCwd,
    {
      env: { ...invocation.env },
      host: decoded.success.config,
      sources: {
        user: decoded.success.configSources?.user ?? true,
        env: decoded.success.configSources?.env ?? true,
      },
      rootOverrides: rootOverridesFromConfig(decoded.success.config),
      ...(snapshot === undefined ? {} : { ...snapshot.inputs, snapshot }),
    },
    invocation,
  );

  // Library mode defaults prompts to non-interactive; the option overrides the
  // bootstrap default mode and is itself overridden by an explicit host
  // InteractionService in plugins.layers (merged last, so it wins).
  const interactionMode = decoded.success.interaction ?? "non-interactive";
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
    ...(bootstrap === "none" || bootstrap === "minimal" ? hostLayersResult.success : []),
  ];
  const hostLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>> =
    decoded.success.installSignalHandlers === true
      ? [...baseHostLayers, signalHandlersLayer as unknown as Layer.Layer<unknown, unknown, unknown>]
      : baseHostLayers;
  return mergeRuntimeWithHostLayers(
    baseLayer as unknown as Layer.Layer<unknown, unknown, unknown>,
    hostLayers,
    bootstrap,
    lifecycle,
  ) as RuntimeLayer;
}
