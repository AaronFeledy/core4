import type { Effect, Layer } from "effect";

import type { ProviderCapabilityError, ProviderUnavailableError, ProxyError } from "../errors/index.ts";
import type { RendererContribution } from "../renderer/index.ts";
import type { HostPlatform, PluginManifest, ProviderId, ServiceConfig } from "../schema/index.ts";
import type { LogFileHelperAssets } from "../services/host-assets.ts";
import type {
  AppFeatureDefinition,
  Downloader,
  FileSyncEngine,
  FileSystem,
  GlobalAppService,
  PathsService,
  ProxyService,
  RuntimeProviderShape,
  ServiceFeatureDefinition,
  ServiceType,
} from "../services/index.ts";
import type { AppPlanSanitizer } from "../services/plan-sanitizer.ts";
import type { TemplateEngine } from "../template/index.ts";
import type { LandoPluginContext } from "./index.ts";

export type RuntimeProviderFactoryRequirements =
  | PathsService
  | Downloader
  | LogFileHelperAssets
  | AppPlanSanitizer;

export interface RuntimeProviderContribution {
  readonly id: ProviderId;
  readonly make: (
    ctx: LandoPluginContext,
  ) => Effect.Effect<
    RuntimeProviderShape,
    ProviderUnavailableError | ProviderCapabilityError,
    RuntimeProviderFactoryRequirements
  >;
}

export interface HostMaintenanceContribution {
  readonly id: string;
  readonly teardown: (input: {
    readonly paths: HostRuntimePaths;
    readonly platform: HostPlatform;
  }) => Effect.Effect<HostTeardownResult, never>;
}

export interface HostRuntimePaths {
  readonly runtimeBinDir: string;
  readonly runtimeRunDir: string;
  readonly runtimeStorageDir: string;
  readonly runtimeConfigDir: string;
  readonly providerSocketPath: string;
  readonly providerPidPath: string;
}

export interface HostTeardownResult {
  readonly terminated: boolean;
  readonly pid?: number;
}

export interface PluginDoctorCheckContribution {
  readonly id: string;
  readonly run: (input: {
    readonly providerId: string;
    readonly platform: HostPlatform;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly userDataRoot: string | undefined;
    readonly binDir: string | undefined;
    readonly stateDir: string | undefined;
  }) => Effect.Effect<ReadonlyArray<PluginDoctorReport>, never>;
}

export interface PluginDoctorReport {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly severity: "info" | "warn" | "error";
  readonly runtimeStatus?: string;
  readonly runtime?: {
    readonly running: boolean;
    readonly version?: string;
  };
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<{
    readonly kind: "automatic" | "manual";
    readonly description: string;
    readonly command?: string;
  }>;
  readonly preempts?: boolean;
}

export type FileSyncEngineContribution = Layer.Layer<FileSyncEngine, unknown, unknown>;
export type ProxyServiceContributionLayer = Layer.Layer<
  ProxyService,
  ProxyError,
  FileSystem | GlobalAppService | PathsService
>;
export type GlobalServiceContributionEffect = Effect.Effect<ServiceConfig, unknown, never>;
export type LoggerContributionLayer = Layer.Layer<never, unknown, unknown>;

export interface LandoPluginModule {
  readonly name: string;
  readonly manifest: PluginManifest;
  readonly layer?: Layer.Layer<never, unknown, unknown>;
  readonly runtimeProviders?: ReadonlyMap<ProviderId, RuntimeProviderContribution>;
  readonly renderers?: ReadonlyMap<string, RendererContribution>;
  readonly fileSyncEngines?: ReadonlyMap<string, FileSyncEngineContribution>;
  readonly templateEngines?: ReadonlyMap<string, TemplateEngine>;
  readonly proxyServices?: ReadonlyMap<string, ProxyServiceContributionLayer>;
  readonly globalServices?: ReadonlyMap<string, GlobalServiceContributionEffect>;
  readonly serviceTypes?: ReadonlyMap<string, ServiceType>;
  readonly serviceFeatures?: ReadonlyMap<string, ServiceFeatureDefinition>;
  readonly appFeatures?: ReadonlyMap<string, AppFeatureDefinition>;
  readonly loggers?: ReadonlyMap<string, LoggerContributionLayer>;
  readonly subscriberFactoryLoaders?: ReadonlyMap<string, () => Promise<unknown>>;
  readonly hostMaintainers?: ReadonlyArray<HostMaintenanceContribution>;
  readonly doctorChecks?: ReadonlyArray<PluginDoctorCheckContribution>;
}

export const definePlugin = (module: LandoPluginModule): LandoPluginModule => module;
