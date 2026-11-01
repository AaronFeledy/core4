import { Schema } from "effect";

import { sha256Hex } from "../digest/index.ts";
import { ArtifactBuildSpec, ArtifactRef } from "./artifacts.ts";
import { DatabaseConnection, ServiceCreds } from "./database-connection.ts";
import { Environment } from "./environment-value.ts";
import { FileSyncSessionSpec } from "./file-sync-engine.ts";
import { FileSyncPolicy } from "./file-sync-policy.ts";
import { EventsPlan } from "./landofile-events.ts";
import { LogSource } from "./log-source.ts";
import { DataStorePlan, MountPlan } from "./mounts.ts";
import {
  type AuthoredNetworkPlan,
  CertificatePlan,
  DependencyPlan,
  EndpointPlan,
  HealthcheckPlan,
  HostAliasPlan,
  NetworkingPlan,
  RoutePlan,
  RouteRef,
  ScanPlan,
} from "./networking.ts";
import {
  AbsoluteContainerPath,
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

export const ServiceHomePlan = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("persisted").annotate({ description: "Lando generated a persistent home store." }),
    target: AbsoluteContainerPath.annotate({ description: "Resolved home directory inside the container." }),
    store: Schema.String.annotate({ description: "Generated home store name." }),
    user: Schema.optionalKey(Schema.String).annotate({
      description: "User principal whose home is persisted, when known.",
    }),
  }),
  Schema.Struct({
    state: Schema.Literal("authored").annotate({
      description: "An authored mount already covers the home directory.",
    }),
    target: AbsoluteContainerPath.annotate({ description: "Resolved home directory inside the container." }),
    mount: Schema.Literals(["volume", "bind", "tmpfs"]).annotate({
      description: "Kind of authored mount at the home target.",
    }),
  }),
  Schema.Struct({
    state: Schema.Literal("disabled").annotate({ description: "Home persistence was explicitly disabled." }),
  }),
  Schema.Struct({
    state: Schema.Literal("unknown").annotate({
      description: "No home store can be planned from the declared image identity.",
    }),
    reason: Schema.Literals(["custom-image", "no-identity", "undeclared-user"]).annotate({
      description: "Why the home directory is unknown.",
    }),
    user: Schema.optionalKey(Schema.String).annotate({
      description: "User principal whose home is unknown, when known.",
    }),
  }),
]).annotate({ identifier: "ServiceHomePlan", description: "Resolved service home persistence status." });
export type ServiceHomePlan = typeof ServiceHomePlan.Type;

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
  init: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Native container init for direct-child signal forwarding and orphan reaping; absence retains provider defaults.",
  }),
  environment: Environment,
  user: Schema.optionalKey(Schema.String),
  home: Schema.optionalKey(ServiceHomePlan).annotate({
    description: "Resolved home status, always set by the planner; optional for hand-built plans.",
  }),
  workingDirectory: Schema.optionalKey(PortablePath),
  mounts: Schema.Array(MountPlan).annotate({
    description:
      "Every container mount, sorted shallow to deep with unique targets; the app-source bind has role app.",
  }),
  endpoints: Schema.Array(EndpointPlan),
  routes: Schema.Array(RouteRef),
  dependsOn: Schema.Array(DependencyPlan),
  healthcheck: Schema.optionalKey(HealthcheckPlan),
  readiness: Schema.optionalKey(HealthcheckPlan).annotate({
    description:
      "Startup probe; defaults to healthcheck when absent. Ongoing native health uses healthcheck only.",
  }),
  readinessSource: Schema.optionalKey(Schema.Literals(["authored", "contributed"])).annotate({
    description:
      "Origin of explicit lifecycle readiness; absent for historical plans with unknown provenance.",
  }),
  startupFailureHint: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))).annotate({
    description:
      "Service-type advice appended to startup and readiness failures, such as the listener flag an authored launcher must pass.",
  }),
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
    connection: Schema.optionalKey(DatabaseConnection).annotate({
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

export const LANDO_SHARED_CROSS_APP_NETWORK = "lando_bridge_network" as const;

const perAppBridgeNetworkName = (slug: string): string => `lando-${slug}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const serviceCrossAppAliases = (
  slug: string,
  serviceName: string,
  hostnames: ReadonlyArray<string> = [],
): ReadonlyArray<string> => Array.from(new Set([`${serviceName}.${slug}.internal`, ...hostnames]));

/**
 * Lando-generated name for an app-owned authored network. App slugs never
 * contain `_`, so the name cannot collide with any app's per-app bridge.
 */
export const landoAuthoredNetworkName = (slug: string, key: string): string => `lando-${slug}_${key}`;

/** Authored intent for one top-level Landofile network that services join. */
type AuthoredNetworkIntent = {
  readonly key: string;
  readonly external: boolean;
  /** Physical name of an external network; defaults to `key`. Owned networks always use a Lando name. */
  readonly name?: string | undefined;
  readonly driver?: string | undefined;
  /** Joined services and the aliases authored for each on this network. */
  readonly members: Readonly<Record<string, ReadonlyArray<string>>>;
};

/**
 * Build the typed `NetworkingPlan`: a private bridge unless explicitly disabled,
 * shared cross-app membership when the selected provider supports
 * `sharedCrossAppNetwork`, and the authored networks services join on top of
 * both. The planner emits this; providers consume it.
 */
export const landoNetworkingPlan = (input: {
  readonly slug: string;
  readonly serviceNames: ReadonlyArray<string>;
  readonly sharedCrossAppNetwork: boolean;
  readonly perAppBridge?: boolean;
  readonly serviceHostnames?: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
  /** Extra per-service aliases on the per-app bridge (`networks.default.aliases`). */
  readonly bridgeAliases?: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
  readonly authoredNetworks?: ReadonlyArray<AuthoredNetworkIntent> | undefined;
}): NetworkingPlan => {
  const bridgeAliases = Object.fromEntries(
    Object.entries(input.bridgeAliases ?? {}).filter(([, aliases]) => aliases.length > 0),
  );
  const perAppBridge =
    input.perAppBridge === false
      ? null
      : {
          name: perAppBridgeNetworkName(input.slug),
          driver: "bridge",
          ...(Object.keys(bridgeAliases).length === 0 ? {} : { aliases: bridgeAliases }),
        };
  const authoredNetworks = (input.authoredNetworks ?? []).map(
    (network): AuthoredNetworkPlan => ({
      key: network.key,
      name: network.external
        ? (network.name ?? network.key)
        : landoAuthoredNetworkName(input.slug, network.key),
      external: network.external,
      ...(network.external ? {} : { driver: network.driver ?? "bridge" }),
      members: Object.fromEntries(
        Object.entries(network.members).map(([service, aliases]) => [
          service,
          { aliases: serviceCrossAppAliases(input.slug, service, aliases) },
        ]),
      ),
    }),
  );
  const authored = authoredNetworks.length === 0 ? {} : { authoredNetworks };
  if (!input.sharedCrossAppNetwork) return { perAppBridge, ...authored };
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
    ...authored,
  };
};

export const landoAppNetworkName = (plan: Pick<AppPlan, "slug" | "networking">): string | undefined =>
  plan.networking === undefined ? perAppBridgeNetworkName(plan.slug) : plan.networking.perAppBridge?.name;

export const landoAppNetworkNames = (plan: Pick<AppPlan, "slug" | "networking">): ReadonlyArray<string> => {
  const name = landoAppNetworkName(plan);
  return name === undefined ? [] : [name];
};

/** Every network the plan attaches any service to: per-app bridge, shared network, then authored networks. */
export const landoNetworkNames = (plan: Pick<AppPlan, "slug" | "networking">): ReadonlyArray<string> => {
  if (plan.networking !== undefined) {
    const names = [...landoAppNetworkNames(plan)];
    if (plan.networking.sharedNetworkMembership !== undefined) {
      names.push(plan.networking.sharedNetworkMembership.name);
    }
    for (const network of plan.networking.authoredNetworks ?? []) names.push(network.name);
    return Array.from(new Set(names));
  }
  return Array.from(new Set([...landoAppNetworkNames(plan), LANDO_SHARED_CROSS_APP_NETWORK]));
};

/** Networks the app owns: the per-app bridge and every non-external authored network. */
export const landoOwnedNetworkNames = (plan: Pick<AppPlan, "slug" | "networking">): ReadonlyArray<string> =>
  Array.from(
    new Set([
      ...landoAppNetworkNames(plan),
      ...(plan.networking?.authoredNetworks ?? [])
        .filter((network) => !network.external)
        .map((network) => network.name),
    ]),
  );

/** Authored networks that exist outside Lando; Lando joins them but never creates or removes them. */
export const landoExternalNetworkNames = (plan: Pick<AppPlan, "networking">): ReadonlyArray<string> =>
  Array.from(
    new Set(
      (plan.networking?.authoredNetworks ?? [])
        .filter((network) => network.external)
        .map((network) => network.name),
    ),
  );

export const landoSharedNetworkName = (plan: Pick<AppPlan, "networking">): string | undefined =>
  plan.networking !== undefined
    ? plan.networking.sharedNetworkMembership?.name
    : LANDO_SHARED_CROSS_APP_NETWORK;

export const landoServiceNetworkAliases = (
  plan: Pick<AppPlan, "slug" | "networking">,
  service: Pick<ServicePlan, "name">,
): ReadonlyArray<string> => {
  if (plan.networking !== undefined) {
    const shared = plan.networking.sharedNetworkMembership;
    return shared === undefined
      ? []
      : serviceCrossAppAliases(plan.slug, service.name, shared.aliases[service.name]);
  }
  return serviceCrossAppAliases(plan.slug, service.name);
};

export const ServiceNetworkAttachment = Schema.Struct({
  name: Schema.String.annotate({ description: "Provider-visible name of the network the service joins." }),
  aliases: Schema.Array(Schema.String).annotate({
    description: "DNS aliases for this service on the network.",
  }),
}).annotate({
  identifier: "ServiceNetworkAttachment",
  description:
    "One realized service network attachment, including its physical network name and DNS aliases.",
});
export type ServiceNetworkAttachment = typeof ServiceNetworkAttachment.Type;

/**
 * The networks one service joins and its DNS aliases on each, in attachment
 * order: the per-app bridge (service name plus `networks.default.aliases`),
 * the shared network (`landoServiceNetworkAliases`), then each authored
 * network the service is a member of. This is the only derivation providers
 * use for container create, connect, fingerprint, and recreate checks.
 */
export const landoServiceNetworkAttachments = (
  plan: Pick<AppPlan, "slug" | "networking">,
  service: Pick<ServicePlan, "name">,
): ReadonlyArray<ServiceNetworkAttachment> => {
  const attachments: ServiceNetworkAttachment[] = [];
  const bridge = landoAppNetworkName(plan);
  const shared = landoSharedNetworkName(plan);
  if (bridge !== undefined) {
    attachments.push({
      name: bridge,
      aliases: Array.from(
        new Set([
          service.name,
          ...(shared === undefined ? [`${service.name}.${plan.slug}.internal`] : []),
          ...(plan.networking?.perAppBridge?.aliases?.[service.name] ?? []),
        ]),
      ),
    });
  }
  if (shared !== undefined)
    attachments.push({ name: shared, aliases: landoServiceNetworkAliases(plan, service) });
  for (const network of plan.networking?.authoredNetworks ?? []) {
    const member = network.members[service.name];
    if (member !== undefined) attachments.push({ name: network.name, aliases: member.aliases });
  }
  return attachments;
};

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
  fileSyncPolicy: Schema.optionalKey(FileSyncPolicy).annotate({
    description:
      "Recorded selection and per-service project-file policy; absent historical reasons are unknown.",
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
