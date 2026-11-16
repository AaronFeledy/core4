/**
 * `AppFeature` contract — the published surface a plugin programs against to
 * mutate selected sibling services across an app plan when a triggering
 * service is present. Where {@link ServiceFeatureDefinition} mutates a
 * single service draft, an `AppFeature` runs once per app after the entire
 * per-service phase, selects a set of resolved service drafts, and applies the
 * same intent mutators to each selected draft.
 */
import type { Effect, Schema } from "effect";

import type { AppFeatureError } from "../errors/index.ts";
import type {
  CommandSpec,
  DatabaseConnection,
  EndpointPlan,
  EnvironmentValue,
  ProviderCapabilities,
  ServiceConfig,
  ServicePlan,
} from "../schema/index.ts";
import type {
  ServiceAppMountIntent,
  ServiceBuildStepIntent,
  ServiceFeatureContext,
  ServiceMountIntent,
} from "./features.ts";

/**
 * Gates declarations and application against resolved service identities and
 * their complete declared feature sets. Application cannot change these facts.
 * A feature whose `activatedBy` does not match is a true no-op.
 */
export interface AppFeatureActivation {
  readonly services?: { readonly type?: string; readonly hasFeature?: string };
}

/**
 * Chooses which resolved service drafts an activated app-feature mutates.
 * Selectors use immutable resolved facts shared by declarations and application,
 * never raw user config or the finalized `AppPlan`.
 */
export interface AppFeatureSelectors {
  readonly types?: ReadonlyArray<string>;
  readonly framework?: ReadonlyArray<string>;
  readonly hasFeature?: ReadonlyArray<string>;
  readonly names?: ReadonlyArray<string>;
  readonly fromConfig?: string;
}

/**
 * Read-only identity of a single selected service draft. Carries the
 * selector-driving fields (`serviceType`, `base`, `framework`, `featureIds`,
 * `config`) so an app-feature can branch on the service it is mutating without
 * reading provider state. App-features MUST NOT change these identity fields.
 */
export interface AppFeatureServiceView {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly base: "l337" | "lando";
  readonly framework?: string | undefined;
  readonly primary: boolean;
  readonly featureIds: ReadonlyArray<string>;
  readonly normalizedConfig: ServiceConfig;
  /** Immutable service-type resolution facts, also retained as plan provenance. */
  readonly resolutionMetadata?: Readonly<NonNullable<ServicePlan["provenance"]>> | undefined;
  readonly connection?: DatabaseConnection | undefined;
}

/**
 * Per-selected-service mutator surface. Exposes the same provider-neutral
 * intent mutators as {@link ServiceFeatureContext} (env, mounts, build steps,
 * healthcheck, and process settings) but scoped to one selected service draft.
 */
export interface AppFeatureServiceMutators {
  readonly service: AppFeatureServiceView;
  addEnv(name: string, value: EnvironmentValue): void;
  addMount(mount: ServiceMountIntent): void;
  setAppMount(mount: ServiceAppMountIntent): void;
  addBuildStep(step: ServiceBuildStepIntent): void;
  addStorage(storage: Parameters<ServiceFeatureContext["addStorage"]>[0]): void;
  addDependency(dependency: Parameters<ServiceFeatureContext["addDependency"]>[0]): void;
  addHostAlias(alias: Parameters<ServiceFeatureContext["addHostAlias"]>[0]): void;
  setHealthcheck(healthcheck: Parameters<ServiceFeatureContext["setHealthcheck"]>[0]): void;
  setReadiness(readiness: Parameters<ServiceFeatureContext["setReadiness"]>[0]): void;
  setCerts(certs: Parameters<ServiceFeatureContext["setCerts"]>[0]): void;
  setEntrypoint(entrypoint: Parameters<ServiceFeatureContext["setEntrypoint"]>[0]): void;
  setCommand(command: Parameters<ServiceFeatureContext["setCommand"]>[0]): void;
  setInit(init: boolean): void;
  setArtifact(artifact: Parameters<ServiceFeatureContext["setArtifact"]>[0]): void;
  setUser(user: string): void;
  setWorkingDirectory(path: Parameters<ServiceFeatureContext["setWorkingDirectory"]>[0]): void;
}

/**
 * Request to materialize a new service draft by cloning a resolved parent
 * after the app-feature pass. A clone shares its parent's image, image-phase
 * build steps, mounts (including the parent's service-scoped stores),
 * environment, user, and networks, because a companion process must see the
 * same files and dependencies as the service it belongs to.
 *
 * A clone never inherits its parent's authored identity: listeners, published
 * ports, routes, hostnames, network aliases, probes, certificates, database
 * credentials, storage-ownership claims, log sources, and `phase: "app"` build
 * steps stay with the parent. Its process is exactly `command`; neither the
 * parent's planned entrypoint nor the image entrypoint applies, and its
 * healthcheck is disabled so an image HEALTHCHECK cannot probe the parent's
 * server. A `user` override runs the clone natively as that user and pins its
 * inherited build steps to the parent's build identity, so the clone's image
 * build is not silently rerun as another user.
 *
 * Clones are materialized after the app-feature pass. One that leaves the plan
 * is removed by the ordinary removed-service convergence on whole-app start,
 * restart, and rebuild; features do not remove clones themselves.
 */
export interface ClonedServiceRequest {
  readonly from: string;
  readonly name: string;
  readonly command: CommandSpec;
  /**
   * Container user the clone runs as. Setting it disables home persistence and
   * home preparation, so the image build stays the parent's steps plus
   * `extraBuildSteps`. Omitted inherits the parent's user and home intent.
   */
  readonly user?: string;
  readonly extraBuildSteps?: ReadonlyArray<ServiceBuildStepIntent>;
  readonly extraEnv?: Readonly<Record<string, EnvironmentValue>>;
  readonly omitConfigKeys?: ReadonlyArray<string>;
}

/**
 * The app-scoped context handed to an app-feature's `apply`. `selected` is the
 * ordered, name-deduplicated set of service drafts the feature's selectors
 * matched; `forEachSelected` and `select(name)` apply intent mutators to those
 * drafts. The context exposes no provider id, capabilities, or realization
 * decision — app-features emit provider-neutral intent only.
 */
export interface AppFeatureContext {
  readonly featureId: string;
  readonly appName?: string | undefined;
  readonly appRoot: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly selected: ReadonlyArray<AppFeatureServiceView>;
  forEachSelected(mutate: (service: AppFeatureServiceMutators) => void): void;
  select(name: string): AppFeatureServiceMutators | undefined;
  /**
   * Queue a companion service cloned from a resolved parent. Intended for
   * feature-created sidecars that must share the parent's image, mounts,
   * environment, and networks without becoming an authored Landofile service.
   * The companion runs exactly the requested `command`, with healthchecks
   * disabled and no log sources. A clone is materialized after the app-feature
   * pass, and one that leaves the plan is removed by the ordinary
   * removed-service convergence on whole-app start, restart, and rebuild.
   */
  addClonedService(request: ClonedServiceRequest): void;
}

/**
 * A composable app-scoped feature. `activatedBy` gates whether it runs;
 * `selectors` chooses which resolved service drafts it mutates; `apply` emits
 * provider-neutral intent to each selected draft. `requires.globalServices`
 * declares global Lando-app services the planner ensures are running in the
 * user app's `pre-start` phase.
 */
export interface AppFeatureDefinition {
  readonly id: string;
  readonly schema?: Schema.Codec<unknown>;
  readonly priority: number;
  readonly activatedBy?: AppFeatureActivation;
  readonly selectors?: AppFeatureSelectors;
  /** Declare listeners for selected services without applying mutations or acquiring resources. */
  readonly declareEndpoints?: (
    ctx: AppEndpointDeclarationContext,
  ) => Effect.Effect<Readonly<Record<string, readonly EndpointPlan[]>>, AppFeatureError>;
  readonly requires?: {
    readonly providerCapabilities?: ReadonlyArray<keyof ProviderCapabilities>;
    readonly globalServices?: ReadonlyArray<string>;
  };
  readonly apply: (ctx: AppFeatureContext) => Effect.Effect<void, AppFeatureError>;
}

export type AppEndpointDeclarationContext = Pick<
  AppFeatureContext,
  "featureId" | "appName" | "appRoot" | "config" | "selected"
>;
