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
import { sha256Hex } from "@lando/sdk/digest";
import { LandofileValidationError } from "@lando/sdk/errors";
import type { ServiceConfig, ServiceHomePlan, ServicePlan } from "@lando/sdk/schema";
import { AbsoluteContainerPath, sameImageReference } from "@lando/sdk/schema";
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
  if (
    service.image !== undefined &&
    (pinnedArtifactTag === undefined || !sameImageReference(service.image, pinnedArtifactTag))
  )
    return true;
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

export const homeStoreName = (appSlug: string, serviceName: string, principal?: string): string => {
  const base = `lando-${appSlug}-${serviceName}-home`;
  if (principal === undefined) return base;
  const readable = principal
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  return `${base}-${readable}-${sha256Hex(`${serviceName}\0${principal}`).slice(0, 8)}`;
};

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
 * mount already covering the same destination keeps its own intent;
 * nothing is generated on top of it.
 */
export const applyServiceHome = (input: {
  readonly servicePlan: ServicePlan;
  readonly serviceName: string;
  readonly appSlug: string;
  readonly appRoot: string;
  readonly intent: ServiceHomeIntent;
}): LandofileValidationError | (ServicePlan & { readonly home: ServiceHomePlan }) => {
  const user =
    input.servicePlan.user ?? (input.intent.customImage ? undefined : input.intent.identity?.defaultUser);
  const principal = user === undefined ? undefined : userPrincipal(user);
  const knownUser = principal === undefined ? {} : { user: principal };
  const resolved = resolveHomePath({
    serviceName: input.serviceName,
    intent: input.intent,
    plannedUser: input.servicePlan.user,
  });
  if (resolved === undefined)
    return {
      ...input.servicePlan,
      home:
        input.intent.home === false
          ? { state: "disabled" }
          : {
              state: "unknown",
              reason: input.intent.customImage
                ? "custom-image"
                : input.intent.identity === undefined
                  ? "no-identity"
                  : "undeclared-user",
              ...knownUser,
            },
    };

  const target = plannedContainerDestination(resolved, input.appRoot, [
    "services",
    input.serviceName,
    "home",
    "path",
  ]);
  if (target instanceof LandofileValidationError) return target;

  const homeTarget = AbsoluteContainerPath.make(target);
  const matches = (destination: string): boolean =>
    plannedContainerDestination(destination, input.appRoot, [
      "services",
      input.serviceName,
      "home",
      "path",
    ]) === target;
  const occupied = input.servicePlan.mounts.find((mount) => matches(mount.target))?.type;
  if (occupied !== undefined)
    return { ...input.servicePlan, home: { state: "authored", target: homeTarget, mount: occupied } };

  const store = homeStoreName(input.appSlug, input.serviceName, principal);

  return {
    ...input.servicePlan,
    home: { state: "persisted", target: homeTarget, store, ...knownUser },
    mounts: [
      ...input.servicePlan.mounts,
      {
        type: "volume",
        origin: "derived",
        store,
        target,
        readOnly: false,
      },
    ],
  };
};
