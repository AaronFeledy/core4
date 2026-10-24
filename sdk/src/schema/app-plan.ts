import { Schema } from "effect";

import { sha256Hex } from "../digest/index.ts";
import { ArtifactBuildSpec, ArtifactRef } from "./artifacts.ts";
import { Environment } from "./environment-value.ts";
import { FileSyncSessionSpec } from "./file-sync-engine.ts";
import { EventsPlan } from "./landofile-events.ts";
import { LogSource } from "./log-source.ts";
import { AppMountPlan, DataStoreMountPlan, DataStorePlan, MountPlan } from "./mounts.ts";
import {
  CertificatePlan,
  DependencyPlan,
  EndpointPlan,
  HealthcheckPlan,
  HostAliasPlan,
  NetworkPlan,
  NetworkingPlan,
  RoutePlan,
  RouteRef,
  ScanPlan,
} from "./networking.ts";
import {
  AbsolutePath,
  AppId,
  CommandSpec,
  PlanMetadata,
  PortablePath,
  ProviderExtensionConfig,
  ProviderId,
  ServiceName,
} from "./primitives.ts";
import { ServiceConnection, ServiceCreds } from "./service-connection.ts";

// ServicePlan + AppPlan — the frozen, schema-validated, provider-neutral
// Description of what a provider must realize.

const ServicePlanFields = {
  name: ServiceName,
  type: Schema.String,
  serviceTypeId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      "Canonical registry ID of the effective service-type declaration or composed inheritance chain.",
  }),
  provider: ProviderId,
  primary: Schema.Boolean,
  artifact: Schema.optionalKey(Schema.Union([ArtifactRef, ArtifactBuildSpec])),
  command: Schema.optionalKey(CommandSpec),
  entrypoint: Schema.optionalKey(CommandSpec),
  environment: Environment,
  user: Schema.optionalKey(Schema.String),
  workingDirectory: Schema.optionalKey(PortablePath),
  appMount: Schema.optionalKey(AppMountPlan),
  mounts: Schema.Array(MountPlan),
  storage: Schema.Array(DataStoreMountPlan),
  endpoints: Schema.Array(EndpointPlan),
  routes: Schema.Array(RouteRef),
  dependsOn: Schema.Array(DependencyPlan),
  healthcheck: Schema.optionalKey(HealthcheckPlan),
  scanner: Schema.optionalKey(ScanPlan).annotate({
    description: "Fully resolved settings for this service's post-start URL scan.",
  }),
  logSources: Schema.optionalKey(Schema.Array(LogSource)),
  certs: Schema.optionalKey(CertificatePlan),
  hostAliases: Schema.Array(HostAliasPlan),
  metadata: PlanMetadata,
  provenance: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Service-type resolution inputs and selected artifact, excluding source file contents.",
  }),
  extensions: ProviderExtensionConfig,
};
export const ServicePlan = Schema.Union([
  Schema.Struct({
    ...ServicePlanFields,
    connection: Schema.optionalKey(ServiceConnection).annotate({
      description: "Canonical database connection resolved by the service type.",
    }),
    nonSqlCreds: Schema.optionalKey(Schema.Never).annotate({
      description: "Non-SQL credentials cannot coexist with a database connection.",
    }),
  }),
  Schema.Struct({
    ...ServicePlanFields,
    connection: Schema.optionalKey(Schema.Never),
    nonSqlCreds: ServiceCreds.annotate({
      description: "Published non-SQL credentials, mutually exclusive with a database connection.",
    }),
  }),
]);
export type ServicePlan = typeof ServicePlan.Type;

// Shared file-sync naming and mount-target contract used by the planner and providers.
export const fileSyncVolumeName = (appName: string, serviceName: string, mountKey: string): string =>
  `${appName}-${serviceName}-${mountKey}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

export const LANDO_SHARED_CROSS_APP_NETWORK = "lando_bridge_network" as const;

const perAppBridgeNetworkName = (slug: string): string => `lando-${slug}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const serviceCrossAppAliases = (
  slug: string,
  serviceName: string,
  hostnames: ReadonlyArray<string> = [],
): ReadonlyArray<string> => Array.from(new Set([`${serviceName}.${slug}.internal`, ...hostnames]));

/**
 * Build the typed `NetworkingPlan`: a private bridge unless explicitly disabled,
 * plus shared cross-app membership when the selected provider supports
 * `sharedCrossAppNetwork`. The planner emits this; providers consume it.
 */
export const landoNetworkingPlan = (input: {
  readonly slug: string;
  readonly serviceNames: ReadonlyArray<string>;
  readonly sharedCrossAppNetwork: boolean;
  readonly perAppBridge?: boolean;
  readonly serviceHostnames?: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
}): NetworkingPlan => {
  const perAppBridge =
    input.perAppBridge === false ? null : { name: perAppBridgeNetworkName(input.slug), driver: "bridge" };
  if (!input.sharedCrossAppNetwork) return { perAppBridge };
  const aliases: Record<string, ReadonlyArray<string>> = {};
  for (const serviceName of input.serviceNames) {
    aliases[serviceName] = serviceCrossAppAliases(
      input.slug,
      serviceName,
      input.serviceHostnames?.[serviceName] ?? [],
    );
  }
  return {
    perAppBridge,
    sharedNetworkMembership: { name: LANDO_SHARED_CROSS_APP_NETWORK, aliases },
  };
};

export const landoAppNetworkName = (plan: Pick<AppPlan, "slug" | "networking">): string | undefined =>
  plan.networking === undefined ? perAppBridgeNetworkName(plan.slug) : plan.networking.perAppBridge?.name;

export const landoAppNetworkNames = (plan: Pick<AppPlan, "slug" | "networking">): ReadonlyArray<string> => {
  const name = landoAppNetworkName(plan);
  return name === undefined ? [] : [name];
};

export const landoNetworkNames = (plan: Pick<AppPlan, "slug" | "networking">): ReadonlyArray<string> => {
  if (plan.networking !== undefined) {
    const names = [...landoAppNetworkNames(plan)];
    if (plan.networking.sharedNetworkMembership !== undefined) {
      names.push(plan.networking.sharedNetworkMembership.name);
    }
    return Array.from(new Set(names));
  }
  return Array.from(new Set([...landoAppNetworkNames(plan), LANDO_SHARED_CROSS_APP_NETWORK]));
};

export const landoSharedNetworkName = (plan: Pick<AppPlan, "networking">): string | undefined =>
  plan.networking !== undefined
    ? plan.networking.sharedNetworkMembership?.name
    : LANDO_SHARED_CROSS_APP_NETWORK;

export const landoServiceNetworkAliases = (
  plan: Pick<AppPlan, "slug" | "networking">,
  service: Pick<ServicePlan, "name">,
): ReadonlyArray<string> => {
  if (plan.networking !== undefined) {
    return plan.networking.sharedNetworkMembership?.aliases[service.name] ?? [];
  }
  return serviceCrossAppAliases(plan.slug, service.name);
};

export const sameAppMountTarget = (
  appMount: ServicePlan["appMount"],
  mount: ServicePlan["mounts"][number],
): boolean =>
  appMount !== undefined &&
  mount.type === "bind" &&
  mount.source === appMount.source &&
  mount.target === appMount.target;

/**
 * One file-sync session entry on an `AppPlan`.
 *
 * Emitted by `AppPlanner` when the selected provider declares
 * `bindMountPerformance: "slow"` and a service has at least one accelerated
 * mount. `engineId` names the `FileSyncEngine` plugin id (e.g. `"mutagen"`)
 * that should realize the session; `session` is the per-mount spec the
 * engine hands to `createSession` at app start.
 */
export const FileSyncPlan = Schema.Struct({
  engineId: Schema.String,
  session: Schema.suspend(
    (): Schema.Codec<FileSyncSessionSpec, typeof FileSyncSessionSpec.Encoded> => FileSyncSessionSpec,
  ).annotate({
    identifier: "FileSyncSessionSpec",
  }),
});
export type FileSyncPlan = typeof FileSyncPlan.Type;

/**
 * The one derivation behind {@link AppIdentity}'s `ownerKey` and `repoGroupKey`.
 *
 * `canonicalPath` MUST already be canonical (realpath-resolved); the planner
 * canonicalizes an app root before hashing it, and every other producer of an
 * ownership key — including volume labels written by a provider — derives it
 * from this function so one root always yields one key.
 */
export const appIdentityKey = (kind: "owner" | "repository", canonicalPath: string): string =>
  sha256Hex(`${kind}\0${canonicalPath}`);

/** Resolve ownership from a planned identity or an older plan's canonical root. */
export const planAppIdentity = (plan: Pick<AppPlan, "root" | "identity">): AppIdentity =>
  plan.identity ?? { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) };

export const AppIdentity = Schema.Struct({
  appRoot: AbsolutePath.annotate({ description: "Canonical root that owns this app instance." }),
  ownerKey: Schema.String.annotate({
    description: "Stable identity derived from the canonical app root.",
  }),
  repoGroupKey: Schema.optionalKey(Schema.String).annotate({
    description: "Stable identity shared by worktrees from one Git common directory.",
  }),
});
export type AppIdentity = typeof AppIdentity.Type;

export const AppPlan = Schema.Struct({
  valueModel: Schema.optionalKey(Schema.Literal(1)).annotate({
    description:
      "Environment descriptor model version; absence is historical observation only, never execution eligibility.",
  }),
  id: AppId.annotate({ description: "Stable application identifier." }),
  name: Schema.String.annotate({ description: "User-facing application name." }),
  slug: Schema.String.annotate({ description: "Normalized application runtime name." }),
  root: AbsolutePath.annotate({ description: "Canonical application root." }),
  identity: Schema.optionalKey(AppIdentity).annotate({
    description: "Canonical ownership and optional repository grouping identity.",
  }),
  provider: ProviderId.annotate({ description: "Provider selected to realize this application." }),
  services: Schema.Record(ServiceName, ServicePlan).annotate({
    description: "Service plans keyed by service name.",
  }),
  routes: Schema.Array(RoutePlan).annotate({ description: "Resolved application routes." }),
  networks: Schema.Array(NetworkPlan).annotate({
    description: "Provider-neutral networks owned by this application.",
  }),
  /**
   * Typed per-app networking intent: the per-app bridge plus optional
   * shared cross-app network membership. Populated by the planner; omitted for
   * service-less apps and legacy/hand-built plans (providers then fall back to
   * slug-derived network names).
   */
  networking: Schema.optionalKey(NetworkingPlan).annotate({
    description: "Private bridge and shared network membership intent.",
  }),
  stores: Schema.Array(DataStorePlan).annotate({
    description: "Named data stores owned or referenced by this application.",
  }),
  /**
   * File-sync sessions auto-selected by the planner for accelerated mounts.
   * Empty when no file sync is needed (native bind-mount providers, or no
   * accelerated mounts on a slow provider).
   */
  fileSync: Schema.Array(FileSyncPlan).annotate({
    description: "File-sync sessions selected during planning.",
  }),
  /**
   * Effective Landofile `events:` and `config.yml hostEvents` steps compiled
   * by the planner. Omitted on hand-built plans. Provider applied state never
   * records it: lifecycle operations resolve Landofile events from the current
   * Landofile, not from what was applied.
   */
  events: Schema.optionalKey(EventsPlan).annotate({
    description:
      "Effective event steps resolved from current project and host configuration, never applied state.",
  }),
  metadata: PlanMetadata.annotate({ description: "Plan provenance and resolution timestamp." }),
  extensions: ProviderExtensionConfig.annotate({ description: "Provider-specific extension intent." }),
  router: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean.annotate({ description: "Whether shared routing is enabled for this app." }),
    }),
  ).annotate({
    description:
      "Resolved router enablement; optional only because persisted cached plans predate this field.",
  }),
  /**
   * Global-app services this app depends on at start, aggregated by the planner
   * (e.g. proxy routes require the global `traefik` service). The user-app start
   * path ensures these are running in the global app before bringing the app up.
   * Omitted when the app needs no global services.
   */
  requires: Schema.optionalKey(
    Schema.Struct({
      globalServices: Schema.Array(Schema.String),
    }),
  ).annotate({ description: "Global services that must be running before application start." }),
});
export type AppPlan = typeof AppPlan.Type;

export const CurrentExecutableAppPlan = Schema.Struct({
  ...AppPlan.fields,
  valueModel: Schema.Literal(1).annotate({
    description: "Required current descriptor model marker; never defaulted during decoding.",
  }),
}).annotate({
  identifier: "CurrentExecutableAppPlan",
  description: "Current plan eligible for creation after environment resolution.",
});
export type CurrentExecutableAppPlan = typeof CurrentExecutableAppPlan.Type;
