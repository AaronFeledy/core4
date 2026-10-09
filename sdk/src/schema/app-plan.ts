import { Schema } from "effect";

import { sha256Hex } from "../digest/index.ts";
import { ArtifactBuildSpec, ArtifactRef } from "./artifacts.ts";
import { FileSyncSessionSpec } from "./file-sync-engine.ts";
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

// ServicePlan + AppPlan — the frozen, schema-validated, provider-neutral
// Description of what a provider must realize.

export const ServicePlan = Schema.Struct({
  name: ServiceName,
  type: Schema.String,
  provider: ProviderId,
  primary: Schema.Boolean,
  artifact: Schema.optionalKey(Schema.Union([ArtifactRef, ArtifactBuildSpec])),
  command: Schema.optionalKey(CommandSpec),
  entrypoint: Schema.optionalKey(CommandSpec),
  environment: Schema.Record(Schema.String, Schema.String),
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
});
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
 * Build the typed per-app `NetworkingPlan`: a per-app bridge network plus
 * shared cross-app membership when the selected provider supports
 * `sharedCrossAppNetwork`. The planner emits this; providers consume it.
 */
export const landoNetworkingPlan = (input: {
  readonly slug: string;
  readonly serviceNames: ReadonlyArray<string>;
  readonly sharedCrossAppNetwork: boolean;
  readonly serviceHostnames?: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
}): NetworkingPlan => {
  const perAppBridge = { name: perAppBridgeNetworkName(input.slug), driver: "bridge" };
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

export const landoAppNetworkName = (plan: Pick<AppPlan, "slug" | "networking">): string =>
  plan.networking?.perAppBridge.name ?? perAppBridgeNetworkName(plan.slug);

export const landoAppNetworkNames = (plan: Pick<AppPlan, "slug" | "networking">): ReadonlyArray<string> => [
  landoAppNetworkName(plan),
];

export const landoNetworkNames = (plan: Pick<AppPlan, "slug" | "networking">): ReadonlyArray<string> => {
  if (plan.networking !== undefined) {
    const names = [plan.networking.perAppBridge.name];
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
  id: AppId,
  name: Schema.String,
  slug: Schema.String,
  root: AbsolutePath,
  identity: Schema.optionalKey(AppIdentity).annotate({
    description: "Canonical ownership and optional repository grouping identity.",
  }),
  provider: ProviderId,
  services: Schema.Record(ServiceName, ServicePlan),
  routes: Schema.Array(RoutePlan),
  networks: Schema.Array(NetworkPlan),
  /**
   * Typed per-app networking intent: the per-app bridge plus optional
   * shared cross-app network membership. Populated by the planner; omitted for
   * service-less apps and legacy/hand-built plans (providers then fall back to
   * slug-derived network names).
   */
  networking: Schema.optionalKey(NetworkingPlan),
  stores: Schema.Array(DataStorePlan),
  /**
   * File-sync sessions auto-selected by the planner for accelerated mounts.
   * Empty when no file sync is needed (native bind-mount providers, or no
   * accelerated mounts on a slow provider).
   */
  fileSync: Schema.Array(FileSyncPlan),
  metadata: PlanMetadata,
  extensions: ProviderExtensionConfig,
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
  ),
});
export type AppPlan = typeof AppPlan.Type;
