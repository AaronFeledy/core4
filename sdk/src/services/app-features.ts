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
import type { ProviderCapabilities, ServiceConfig } from "../schema/index.ts";
import type {
  ServiceAppMountIntent,
  ServiceBuildStepIntent,
  ServiceFeatureContext,
  ServiceMountIntent,
} from "./features.ts";

/**
 * Gates whether an app-feature runs for a given app. Evaluated after the entire
 * per-service phase (service-type resolution + service-feature application) has
 * completed for every service, so `hasFeature` reads a service's final feature
 * set. A feature whose `activatedBy` does not match is a true no-op.
 */
export interface AppFeatureActivation {
  readonly services?: { readonly type?: string; readonly hasFeature?: string };
}

/**
 * Chooses which resolved service drafts an activated app-feature mutates.
 * Selectors are evaluated against the post-resolution, post-service-feature
 * drafts — never raw user config and never the finalized `AppPlan`.
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
}

/**
 * Per-selected-service mutator surface. Exposes the same provider-neutral
 * intent mutators as {@link ServiceFeatureContext} (env, mounts, build steps,
 * endpoints, healthcheck, …) but scoped to one selected service draft.
 */
export interface AppFeatureServiceMutators {
  readonly service: AppFeatureServiceView;
  addEnv(name: string, value: string): void;
  addMount(mount: ServiceMountIntent): void;
  setAppMount(mount: ServiceAppMountIntent): void;
  addBuildStep(step: ServiceBuildStepIntent): void;
  addStorage(storage: Parameters<ServiceFeatureContext["addStorage"]>[0]): void;
  addEndpoint(endpoint: Parameters<ServiceFeatureContext["addEndpoint"]>[0]): void;
  addDependency(dependency: Parameters<ServiceFeatureContext["addDependency"]>[0]): void;
  addHostAlias(alias: Parameters<ServiceFeatureContext["addHostAlias"]>[0]): void;
  setHealthcheck(healthcheck: Parameters<ServiceFeatureContext["setHealthcheck"]>[0]): void;
  setCerts(certs: Parameters<ServiceFeatureContext["setCerts"]>[0]): void;
  setEntrypoint(entrypoint: Parameters<ServiceFeatureContext["setEntrypoint"]>[0]): void;
  setCommand(command: Parameters<ServiceFeatureContext["setCommand"]>[0]): void;
  setArtifact(artifact: Parameters<ServiceFeatureContext["setArtifact"]>[0]): void;
  setUser(user: string): void;
  setWorkingDirectory(path: Parameters<ServiceFeatureContext["setWorkingDirectory"]>[0]): void;
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
  readonly schema?: Schema.Schema<unknown>;
  readonly priority: number;
  readonly activatedBy?: AppFeatureActivation;
  readonly selectors?: AppFeatureSelectors;
  readonly requires?: {
    readonly providerCapabilities?: ReadonlyArray<keyof ProviderCapabilities>;
    readonly globalServices?: ReadonlyArray<string>;
  };
  readonly apply: (ctx: AppFeatureContext) => Effect.Effect<void, AppFeatureError>;
}
