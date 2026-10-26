/**
 * Planned-user home persistence.
 *
 * A service keeps its home directory across rebuilds only when the planner can
 * say where that home is. The service type declares the identities inside the
 * image it ships; a service that supplies its own `image:` or Compose `build:`
 * is a custom image, so that declaration no longer describes it. When neither
 * the type nor the author names a home for the planned user, no home store is
 * planned rather than guessing a path.
 */
import { LandofileValidationError } from "@lando/sdk/errors";
import type { ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import type { ServiceImageIdentity } from "@lando/sdk/services";

import { plannedContainerDestination } from "./storage.ts";

/** What planning knows about one service's home before the plan is finalized. */
export interface ServiceHomeIntent {
  /** Service type id. */
  readonly serviceType: string;
  /** Identities declared by the service type, absent for a custom image. */
  readonly identity?: ServiceImageIdentity;
  /** Authored `home:` value; `undefined` means enabled with no explicit path. */
  readonly home?: ServiceConfig["home"];
  /** True when the Landofile supplied the image, so `identity` cannot describe it. */
  readonly customImage?: boolean;
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
  const customImage = hasCustomImage(input.service, input.pinnedArtifactTag);
  const known = customImage ? undefined : input.identity;
  return {
    serviceType: input.serviceTypeId,
    customImage,
    ...(known === undefined ? {} : { identity: known }),
    ...(input.service.home === undefined ? {} : { home: input.service.home }),
  };
};

/** The user principal a home is keyed by: the identity without its `:group`. */
const userPrincipal = (user: string): string => {
  const separator = user.indexOf(":");
  return separator === -1 ? user : user.slice(0, separator);
};

export const homeStoreName = (appSlug: string, serviceName: string): string =>
  `lando-${appSlug}-${serviceName}-home`;

/**
 * Resolves the home destination for one service. Returns `undefined` when home
 * persistence is off or the destination is unknown.
 */
export const resolveHomePath = (input: {
  readonly serviceName: string;
  readonly intent: ServiceHomeIntent;
  readonly plannedUser: string | undefined;
}): string | undefined => {
  const home = input.intent.home;
  if (home === false) return undefined;
  if (home?.path !== undefined) return home.path;

  const identity = input.intent.identity;
  if (identity === undefined || input.intent.customImage) return undefined;

  const principal = userPrincipal(input.plannedUser ?? identity.defaultUser);
  return Object.hasOwn(identity.homes, principal) ? identity.homes[principal] : undefined;
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
  readonly appRoot: string;
  readonly intent: ServiceHomeIntent;
}): LandofileValidationError | ServicePlan => {
  const resolved = resolveHomePath({
    serviceName: input.serviceName,
    intent: input.intent,
    plannedUser: input.servicePlan.user,
  });
  if (resolved === undefined) return input.servicePlan;

  const target = plannedContainerDestination(resolved, input.appRoot, [
    "services",
    input.serviceName,
    "home",
    "path",
  ]);
  if (target instanceof LandofileValidationError) return target;

  const occupied = input.servicePlan.storage.some((mount) => mount.target === target);
  if (occupied) return input.servicePlan;

  return {
    ...input.servicePlan,
    storage: [
      ...input.servicePlan.storage,
      {
        store: homeStoreName(input.appSlug, input.serviceName),
        target,
        readOnly: false,
      },
    ],
  };
};
