import { type Context, Effect, Layer, Result, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";

import { type ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
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
import type { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
import type { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import type { FileSyncResolver } from "@lando/engine/plugins/file-sync-resolver";
import type { BootstrapLevel } from "@lando/engine/runtime/bootstrap";
import type { BootstrapLayerInputs } from "@lando/engine/runtime/bootstrap-layer-support";
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
import {
  makeGenerationAppBootstrapLayer,
  makeGenerationHostBootstrapLayer,
} from "./generated/layers/generation";
import { makeGeneratedBootstrapLayer, mergeRuntimeWithHostLayers } from "./generated/layers/index";
import type { MinimalBootstrapServices } from "./generated/layers/minimal";
import "./engine-composition";
import {
  CliInvocation,
  type CliInvocationContext,
  processInvocationContext,
  processInvocationDefaults,
} from "./invocation-context";

export { LandoRuntimeOptions } from "@lando/engine/runtime/runtime-options";

type HostLayer = ReturnType<typeof makeGenerationHostBootstrapLayer>;
type GenerationLayer = ReturnType<typeof makeGenerationAppBootstrapLayer>;
export type GenerationHostServices = Layer.Success<HostLayer>;
export type AppGenerationServices = Layer.Success<GenerationLayer>;

export interface LandoGenerationRuntime {
  readonly host: HostLayer;
  readonly generation: (input: {
    readonly cwd: string;
    readonly host: Context.Context<MinimalBootstrapServices>;
  }) => GenerationLayer;
  readonly pluginPolicy: NormalizedPluginPolicy;
}

export const makeLandoGenerationRuntime = (
  options: LandoRuntimeOptions,
  invocation: CliInvocationContext = processInvocationContext(),
): Result.Result<LandoGenerationRuntime, LandoRuntimeBootstrapError> =>
  Result.map(prepareRuntime({ ...options, bootstrap: "app" }, undefined, invocation), (prepared) => ({
    host: makeGenerationHostBootstrapLayer(prepared.inputs, interactionServiceFor(prepared.options)),
    generation: ({ cwd, host }) =>
      makeGenerationAppBootstrapLayer({
        ...prepared.inputs,
        cwd,
        lifecycle: makeBootstrapLifecycleTracker(),
        minimalContext: host,
      }),
    pluginPolicy: prepared.pluginPolicy,
  }));

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

export interface PreparedRuntime {
  readonly options: LandoRuntimeOptions;
  readonly bootstrap: BootstrapLevel;
  readonly capturedCwd: string;
  readonly pluginPolicy: NormalizedPluginPolicy;
  readonly lifecycle: BootstrapLifecycleTracker;
  readonly embeddingLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>>;
  readonly inputs: BootstrapLayerInputs;
}

/** Decode runtime options into the generated bootstrap inputs shared by every runtime factory. */
export const prepareRuntime = (
  options: unknown,
  snapshot: GlobalConfigSnapshot["Service"] | undefined,
  invocation: CliInvocationContext,
): Result.Result<PreparedRuntime, LandoRuntimeBootstrapError> => {
  const decoded = Schema.decodeUnknownResult(LandoRuntimeOptions)(options);

  if (Result.isFailure(decoded)) {
    return Result.fail(bootstrapError("Invalid Lando runtime options.", decoded.failure));
  }

  const pluginPolicy = normalizePluginPolicy(decoded.success.plugins);
  if (pluginPolicy.discovery.bundled && bundledPluginModules().length === 0) {
    return Result.fail(
      new LandoRuntimeBootstrapError({
        message:
          "Bundled plugin discovery requires importing @lando/core/bundled-plugins before constructing the runtime.",
        stage: "plugins",
        remediation:
          "Import `@lando/core/bundled-plugins` before constructing the runtime (or use the CLI entrypoint that loads bundled plugins).",
      }),
    );
  }
  const capturedCwd = decoded.success.cwd ?? invocation.cwd;
  const lifecycle = makeBootstrapLifecycleTracker();
  const hostLayersResult = collectEmbeddingPluginLayers([
    ...pluginPolicy.layers,
    ...(invocation.serviceLayers ?? []),
  ]);

  if (Result.isFailure(hostLayersResult)) {
    return Result.fail(hostLayersResult.failure);
  }
  const logging = resolveRuntimeLogging(decoded.success);
  return Result.succeed({
    options: decoded.success,
    bootstrap: decoded.success.bootstrap ?? "app",
    capturedCwd,
    pluginPolicy,
    lifecycle,
    embeddingLayers: hostLayersResult.success,
    inputs: {
      runtimeLayerFactory: { make: makeLandoRuntime },
      lifecycle,
      loggerMode: logging.loggerMode,
      logLevel: logging.logLevel,
      structured: logging.structured,
      writeDiagnosticLine: (line) => {
        invocation.io.writeStderr(`${line}\n`);
      },
      stderrIsTTY: invocation.io.isTTY === true,
      rendererMode: normalizeLibraryRendererMode(
        decoded.success.renderer ?? decoded.success.config?.renderer,
      ),
      telemetryEnabled: decoded.success.telemetry ?? decoded.success.config?.telemetry?.enabled ?? false,
      pluginDiscovery: pluginPolicy.discovery,
      pluginLayers: hostLayersResult.success,
      ...(invocation.providerRegistry === undefined
        ? {}
        : { runtimeProviderRegistry: invocation.providerRegistry }),
      pluginManifests: pluginPolicy.manifests,
      externalImports: pluginPolicy.externalImports,
      cwd: capturedCwd,
      configInputs: {
        env: { ...invocation.env },
        host: decoded.success.config,
        sources: {
          user: decoded.success.configSources?.user ?? true,
          env: decoded.success.configSources?.env ?? true,
        },
        rootOverrides: rootOverridesFromConfig(decoded.success.config),
        ...(snapshot === undefined ? {} : { ...snapshot.inputs, snapshot }),
      },
    },
  });
};

export const interactionServiceFor = (options: LandoRuntimeOptions) =>
  Layer.succeed(
    InteractionServiceTag,
    makeInteractionService({
      defaultMode: options.interaction ?? "non-interactive",
      resolveDriver: makeDefaultResolveInteractionDriver(),
    }),
  );

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
  const prepared = prepareRuntime(options, snapshot, invocation);
  if (Result.isFailure(prepared)) return Layer.effectDiscard(Effect.fail(prepared.failure));
  const { options: decoded, bootstrap, capturedCwd, lifecycle, embeddingLayers, inputs } = prepared.success;
  const baseLayer = makeGeneratedBootstrapLayer(bootstrap, inputs) as RuntimeLayer;

  // Library mode defaults prompts to non-interactive; the option overrides the
  // bootstrap default mode and is itself overridden by an explicit host
  // InteractionService in plugins.layers (merged last, so it wins).
  const interactionOverride = interactionServiceFor(decoded) as unknown as Layer.Layer<
    unknown,
    unknown,
    unknown
  >;

  const baseHostLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>> = [
    Layer.succeed(RuntimeCwd, capturedCwd) as unknown as Layer.Layer<unknown, unknown, unknown>,
    interactionOverride,
    ...(bootstrap === "none" || bootstrap === "minimal" ? embeddingLayers : []),
  ];
  const hostLayers: ReadonlyArray<Layer.Layer<unknown, unknown, unknown>> =
    decoded.installSignalHandlers === true
      ? [...baseHostLayers, signalHandlersLayer as unknown as Layer.Layer<unknown, unknown, unknown>]
      : baseHostLayers;
  return mergeRuntimeWithHostLayers(
    baseLayer as unknown as Layer.Layer<unknown, unknown, unknown>,
    hostLayers,
    bootstrap,
    lifecycle,
  ) as RuntimeLayer;
}
