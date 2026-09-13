/**
 * Planned-user home persistence.
 *
 * A service keeps its home directory across rebuilds only when the planner can
 * say where that home is. The service type declares the identities inside the
 * image it ships; a service that supplies its own `image:` or Compose `build:`
 * is a custom image, so that declaration no longer describes it. When neither
 * the type nor the author names a home, planning fails before any provider
 * action rather than guessing a path.
 */
import { HomePathCapabilityError } from "@lando/sdk/errors";
import { PortablePath, type ServiceConfig, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceImageIdentity } from "@lando/sdk/services";

/** What planning knows about one service's home before the plan is finalized. */
export interface ServiceHomeIntent {
  /** Service type id, reported with a refusal. */
  readonly serviceType: string;
  /** Identities declared by the service type, absent for a custom image. */
  readonly identity?: ServiceImageIdentity;
  /** Authored `home:` value; `undefined` means enabled with no explicit path. */
  readonly home?: ServiceConfig["home"];
}

/**
 * True when the Landofile supplies the image instead of the service type.
 *
 * Planning writes the service type's own published artifact tag onto the config
 * as `image` before this runs, so that tag is passed in and ignored: it is
 * Lando's image and the type's identity still describes it.
 */
export const hasCustomImage = (service: ServiceConfig, pinnedArtifactTag?: string | undefined): boolean => {
  if (service.image !== undefined && service.image !== pinnedArtifactTag) return true;
  const build = service.build;
  return build !== undefined && "context" in build;
};

export const serviceHomeIntent = (input: {
  readonly service: ServiceConfig;
  readonly serviceTypeId: string;
  readonly identity: ServiceImageIdentity | undefined;
  readonly pinnedArtifactTag?: string | undefined;
}): ServiceHomeIntent => {
  const known = hasCustomImage(input.service, input.pinnedArtifactTag) ? undefined : input.identity;
  return {
    serviceType: input.serviceTypeId,
    ...(known === undefined ? {} : { identity: known }),
    ...(input.service.home === undefined ? {} : { home: input.service.home }),
  };
};

/** The user principal a home is keyed by: the identity without its `:group`. */
const userPrincipal = (user: string): string => {
  const separator = user.indexOf(":");
  return separator === -1 ? user : user.slice(0, separator);
};

/** Compares container destinations without letting a trailing slash matter. */
export const containerTargetKey = (target: string): string =>
  target.length > 1 && target.endsWith("/") ? target.slice(0, -1) : target;

export const homeStoreName = (appSlug: string, serviceName: string): string =>
  `lando-${appSlug}-${serviceName}-home`;

const refusal = (input: {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly user?: string | undefined;
  readonly reason: string;
}): HomePathCapabilityError =>
  new HomePathCapabilityError({
    message: `Service ${input.serviceName} persists its home directory, but ${input.reason}`,
    service: input.serviceName,
    serviceType: input.serviceType,
    ...(input.user === undefined ? {} : { user: input.user }),
    remediation: `Set services.${input.serviceName}.home: false to skip home persistence, or set services.${input.serviceName}.home.path to an absolute container path.`,
  });

/**
 * Resolves the home destination for one service. Returns `undefined` when home
 * persistence is off, and a tagged refusal when the destination is unknowable.
 */
export const resolveHomePath = (input: {
  readonly serviceName: string;
  readonly intent: ServiceHomeIntent;
  readonly plannedUser: string | undefined;
}): HomePathCapabilityError | string | undefined => {
  const home = input.intent.home;
  if (home === false) return undefined;
  if (home?.path !== undefined) return home.path;

  const identity = input.intent.identity;
  if (identity === undefined) {
    return refusal({
      serviceName: input.serviceName,
      serviceType: input.intent.serviceType,
      ...(input.plannedUser === undefined ? {} : { user: input.plannedUser }),
      reason:
        "its image is supplied by the Landofile, so Lando does not know which user runs it or where that user's home is.",
    });
  }

  const user = input.plannedUser ?? identity.defaultUser;
  const path = identity.homes[userPrincipal(user)];
  if (path === undefined) {
    return refusal({
      serviceName: input.serviceName,
      serviceType: input.intent.serviceType,
      user,
      reason: `service type ${input.intent.serviceType} does not declare a home directory for user ${user}.`,
    });
  }
  return path;
};

/**
 * Adds the generated home store to a finalized service plan. An authored
 * storage entry already covering the same destination keeps its own store name,
 * scope, and ownership; nothing is generated on top of it.
 */
export const applyServiceHome = (input: {
  readonly servicePlan: ServicePlan;
  readonly serviceName: string;
  readonly appSlug: string;
  readonly intent: ServiceHomeIntent;
}): HomePathCapabilityError | ServicePlan => {
  const resolved = resolveHomePath({
    serviceName: input.serviceName,
    intent: input.intent,
    plannedUser: input.servicePlan.user,
  });
  if (resolved instanceof HomePathCapabilityError) return resolved;
  if (resolved === undefined) return input.servicePlan;

  const target = containerTargetKey(resolved);
  const occupied = input.servicePlan.storage.some(
    (mount) => containerTargetKey(String(mount.target)) === target,
  );
  if (occupied) return input.servicePlan;

  return {
    ...input.servicePlan,
    storage: [
      ...input.servicePlan.storage,
      {
        store: homeStoreName(input.appSlug, input.serviceName),
        target: PortablePath.make(resolved),
        readOnly: false,
      },
    ],
  };
};
