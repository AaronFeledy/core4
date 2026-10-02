import type { Effect, Layer } from "effect";
import type { SecretStoreUnavailableError } from "../errors/secret.ts";

import type {
  ProviderCapabilityError,
  ProviderUnavailableError,
  ProxyError,
  SshError,
} from "../errors/index.ts";
import type { RendererContribution } from "../renderer/index.ts";
import type {
  AppPlan,
  HostPlatform,
  PluginManifest,
  ProviderCapabilities,
  ProviderId,
  ServiceConfig,
} from "../schema/index.ts";
import type {
  DoctorAppIdentity,
  DoctorExecutableLocation,
  DoctorResourceInspection,
  DoctorResourceNameQuery,
  PluginDoctorReport,
} from "../schema/plugin-doctor.ts";
import type { ConfigTranslatorShape } from "../services/config-translator.ts";
import type { LogFileHelperAssets } from "../services/host-assets.ts";
import type {
  AppFeatureDefinition,
  CertificateAuthority,
  Downloader,
  FileSyncEngine,
  FileSystem,
  GlobalAppService,
  PathsService,
  ProcessRunner,
  RouterService,
  RuntimeProviderShape,
  SecretStore,
  ServiceFeatureDefinition,
  ServiceType,
  SshService,
} from "../services/index.ts";
import type { AppPlanSanitizer } from "../services/plan-sanitizer.ts";
import type { TemplateEngine } from "../template/index.ts";
import type { ExecutableCommandLoader } from "./command.ts";
import type { LandoPluginContext } from "./index.ts";

export type RuntimeProviderFactoryRequirements =
  | PathsService
  | Downloader
  | LogFileHelperAssets
  | AppPlanSanitizer;

export interface RuntimeProviderContribution {
  readonly id: ProviderId;
  /** Read durable ownership claims without connecting to or initializing the runtime. */
  readonly appliedPlans: (
    ctx: LandoPluginContext,
  ) => Effect.Effect<ReadonlyArray<AppPlan>, ProviderUnavailableError, PathsService>;
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

/**
 * Bounded name/label inspector over the selected provider. Core runs each
 * query under a deadline and never lets it fail; the provider is contacted
 * only when `inspect` is called.
 */
export interface DoctorResourceInspector {
  readonly inspect: (query: DoctorResourceNameQuery) => Effect.Effect<DoctorResourceInspection, never>;
}

/**
 * Filesystem/PATH-only executable locator. It never executes a candidate and
 * never reads candidate contents or user/Lando state.
 */
export interface DoctorExecutableLocator {
  readonly locate: (name: string) => Effect.Effect<DoctorExecutableLocation, never>;
}

export interface PluginDoctorCheckInput {
  /** Selected provider id; the check decides whether it may contact the daemon. */
  readonly providerId: string;
  readonly platform: HostPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userDataRoot: string | undefined;
  readonly binDir: string | undefined;
  readonly stateDir: string | undefined;
  /** Present only when doctor runs inside a loadable app. */
  readonly app?: DoctorAppIdentity | undefined;
  readonly resources?: DoctorResourceInspector | undefined;
  readonly executables?: DoctorExecutableLocator | undefined;
}

export interface PluginDoctorCheckContribution {
  readonly id: string;
  readonly relevant?: (capabilities: ProviderCapabilities) => boolean;
  readonly run: (input: PluginDoctorCheckInput) => Effect.Effect<ReadonlyArray<PluginDoctorReport>, never>;
}

export type { PluginDoctorReport } from "../schema/plugin-doctor.ts";

/**
 * Lazy `ConfigTranslator` factory. Plugins wrap a dynamic import so the
 * translator implementation loads only for an explicit conversion request;
 * the loader closes over any injected SDK ports such as `RecipeDecomposer`.
 */
export type ConfigTranslatorLoader = () => Promise<ConfigTranslatorShape>;

export type FileSyncEngineContribution = Layer.Layer<FileSyncEngine, unknown, unknown>;
export type CertificateAuthorityContributionLayer = Layer.Layer<
  CertificateAuthority,
  never,
  PathsService | Downloader | ProcessRunner
>;
export type RouterServiceContributionLayer = Layer.Layer<
  RouterService,
  ProxyError,
  CertificateAuthority | FileSystem | GlobalAppService | PathsService
>;
export interface RouterServiceContribution {
  readonly make: (ctx: LandoPluginContext) => RouterServiceContributionLayer;
}
export type SshServiceContributionLayer = Layer.Layer<
  SshService,
  SshError,
  FileSystem | GlobalAppService | PathsService
>;
export type SecretStoreContributionLayer = Layer.Layer<
  SecretStore,
  SecretStoreUnavailableError,
  ProcessRunner | PathsService | FileSystem
>;
export type GlobalServiceContributionEffect = Effect.Effect<ServiceConfig, unknown, never>;
export type LoggerContributionLayer = Layer.Layer<never, unknown, unknown>;

export interface LandoPluginModule {
  readonly name: string;
  readonly manifest: PluginManifest;
  readonly layer?: Layer.Layer<never, unknown, unknown>;
  readonly runtimeProviders?: ReadonlyMap<ProviderId, RuntimeProviderContribution>;
  readonly renderers?: ReadonlyMap<string, RendererContribution>;
  readonly commands?: ReadonlyMap<string, ExecutableCommandLoader>;
  readonly configTranslators?: ReadonlyMap<string, ConfigTranslatorLoader>;
  readonly fileSyncEngines?: ReadonlyMap<string, FileSyncEngineContribution>;
  readonly certificateAuthorities?: ReadonlyMap<string, CertificateAuthorityContributionLayer>;
  readonly templateEngines?: ReadonlyMap<string, TemplateEngine>;
  readonly routerServices?: ReadonlyMap<string, RouterServiceContribution>;
  readonly sshServices?: ReadonlyMap<string, SshServiceContributionLayer>;
  readonly secretStores?: ReadonlyMap<string, SecretStoreContributionLayer>;
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
