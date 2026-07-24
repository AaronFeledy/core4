/**
 * `ServiceFeature` contract — the published surface a feature author programs
 * against, and the mutable draft surface core hands to each feature's `apply`.
 *
 * A service is composed from a `base` (`l337` or `lando`) plus a sequence of
 * priority-ordered features. Each feature mutates a provider-neutral
 * in-memory draft through {@link ServiceFeatureContext}; core's composition
 * engine seeds the draft, runs features in ascending `priority`, and emits a
 * provider-neutral plan draft. Features emit INTENT ONLY: the context exposes
 * no provider id, no provider capabilities, and no realization decision, so a
 * feature cannot choose a bind/accelerated strategy or read provider state.
 * Provider realization is the single finalization stage's job, not a feature's.
 */
import type { Effect, Schema } from "effect";

import type { ServiceFeatureError } from "../errors/index.ts";
import type {
  AppMountPlan,
  ArtifactBuildSpec,
  ArtifactRef,
  CertificatePlan,
  CommandSpec,
  DataStoreMountPlan,
  DependencyPlan,
  EndpointPlan,
  HealthcheckPlan,
  HostAliasPlan,
  MountPlan,
  PortablePath,
  ProviderCapabilities,
  ServiceConfig,
} from "../schema/index.ts";
import type { ServiceTypeHostFacts } from "./plugins.ts";

/**
 * A mount a feature declares, stripped of the `realization` decision. Features
 * declare WHAT to mount; whether the mount is a provider-native bind or routed
 * through a file-sync engine is decided later by core's finalization stage.
 */
export type ServiceMountIntent = Omit<MountPlan, "realization">;

/**
 * The app-source mount a feature declares, stripped of the `realization`
 * decision (same reasoning as {@link ServiceMountIntent}).
 */
export type ServiceAppMountIntent = Omit<AppMountPlan, "realization">;

/**
 * A build step a feature declares. `ServicePlan` carries no build-step slot;
 * the draft retains build-step intent for the build-orchestration
 * consumer. Provider-neutral: a feature never names a provider here.
 */
export interface ServiceBuildStepIntent {
  /** Optional stable id for ordering/dedup by the build orchestrator. */
  readonly id?: string;
  /** Build phase the step belongs to (e.g. `"prebuild"`, `"build"`, `"postbuild"`). */
  readonly phase: string;
  /** The command(s) to run for this step. */
  readonly command: CommandSpec;
  /** Resolved immutable artifact identities included in the image build key but not rendered as commands. */
  readonly buildKeyInputs?: Readonly<Record<string, unknown>>;
  /** Step ids this step depends on, if any. */
  readonly dependsOn?: ReadonlyArray<string>;
}

/**
 * The mutable draft surface handed to a feature's `apply`. Backed by a
 * provider-neutral draft, NOT a finished `ServicePlan`. Exposes read-only
 * service/base facts plus intent mutators. It deliberately exposes no
 * `providerId`, no `provider`, no `capabilities`, and no draft accessor, so a
 * feature can only emit intent — it cannot read provider state or make a
 * realization/bind decision.
 */
export interface ServiceFeatureContext {
  /** The service's name in the resolved Landofile. */
  readonly serviceName: string;
  /** The resolved service type id (e.g. `"php"`, `"compose"`). */
  readonly serviceType: string;
  /** The base this service composes onto. */
  readonly base: "l337" | "lando";
  /** Whether this is the app's primary service. */
  readonly primary: boolean;
  /** The app name, when known. */
  readonly appName?: string | undefined;
  /** Absolute host path of the app root. */
  readonly appRoot: string;
  /** Host identity facts (os/user/uid/gid/home), when the planner supplied them. */
  readonly host?: ServiceTypeHostFacts | undefined;
  /** The service type's normalized config for this service. */
  readonly normalizedConfig: ServiceConfig;
  /** This feature's decoded config (from its `FeatureRef.config`, via `schema`). */
  readonly config: Readonly<Record<string, unknown>>;

  /** Add or overwrite an environment variable on the draft. */
  addEnv(name: string, value: string): void;
  /** Add a mount (without a realization decision). */
  addMount(mount: ServiceMountIntent): void;
  /** Set the app-source mount (without a realization decision). */
  setAppMount(mount: ServiceAppMountIntent): void;
  /** Add a build step (retained on the draft for the build orchestrator). */
  addBuildStep(step: ServiceBuildStepIntent): void;
  /** Add or overwrite a provider-neutral service plan extension. */
  addExtension(key: string, value: unknown): void;
  /** Add a data-store mount. */
  addStorage(storage: DataStoreMountPlan): void;
  /** Add a service endpoint. */
  addEndpoint(endpoint: EndpointPlan): void;
  /** Add a service dependency. */
  addDependency(dependency: DependencyPlan): void;
  /** Add a host alias. */
  addHostAlias(alias: HostAliasPlan): void;
  /** Set the service healthcheck. */
  setHealthcheck(healthcheck: HealthcheckPlan): void;
  /** Set the service certificate plan. */
  setCerts(certs: CertificatePlan): void;
  /** Set the service entrypoint. */
  setEntrypoint(entrypoint: CommandSpec): void;
  /** Set the default command. */
  setCommand(command: CommandSpec): void;
  /** Set the artifact (image ref or build spec). */
  setArtifact(artifact: ArtifactRef | ArtifactBuildSpec): void;
  /** Set the in-container user. */
  setUser(user: string): void;
  /** Set the working directory. */
  setWorkingDirectory(path: PortablePath): void;
}

/**
 * A composable service feature. `apply` mutates the draft via
 * {@link ServiceFeatureContext} and emits provider-neutral intent only. `schema`
 * (when present) decodes the feature's config before `apply`. `requires`
 * declares provider-capability metadata for later capability planning; a
 * feature MUST NOT read capabilities itself.
 */
export interface ServiceFeatureDefinition {
  readonly id: string;
  readonly schema?: Schema.Schema<unknown>;
  readonly priority: number;
  readonly requires?: ReadonlyArray<keyof ProviderCapabilities>;
  readonly apply: (ctx: ServiceFeatureContext) => Effect.Effect<void, ServiceFeatureError>;
}
