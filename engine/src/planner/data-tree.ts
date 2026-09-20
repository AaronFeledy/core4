/**
 * Ownership of the volume-backed data trees a service writes to at start.
 *
 * A service that mounts a named volume over a tree it writes to — Solr's
 * `/var/solr`, MinIO's `/data` — can only write there when the planned user
 * owns that tree. A container runtime seeds a fresh named volume from the
 * image directory at the mount point, ownership included, so ownership is
 * decided in the image and not at start: one root build step creates the tree
 * and gives it to the planned user, and the runtime carries that onto the
 * volume the first time it is created.
 *
 * The step is only emitted when the planned user is not already an owner the
 * image seeds, so a default or root plan gains no build step and no rebuild.
 * When the planner cannot know that the planned user exists inside the image,
 * planning fails before any provider action rather than shipping an image
 * whose build would fail, or a container that would exit on its own launcher.
 */
import { DataTreeOwnershipCapabilityError } from "@lando/sdk/errors";
import type { ServiceBuildStepIntent, ServiceImageIdentity } from "@lando/sdk/services";

/** One mounted tree a service writes to, and the owners its image already seeds. */
export interface DataTreeIntent {
  /** Container path the data store is mounted at. */
  readonly target: string;
  /**
   * Principals the image already gives ownership of this target. A fresh
   * volume inherits that ownership, so these need no preparation.
   */
  readonly seededOwners: ReadonlyArray<string>;
}

/** A tree that has to be prepared in the image, and the principal to give it to. */
export interface DataTreeOwnership {
  readonly target: string;
  readonly owner: string;
}

const ROOT_PRINCIPALS = new Set(["root", "0"]);
const NUMERIC_PRINCIPAL = /^[0-9]+$/u;

/** The user principal ownership is keyed by: the identity without its `:group`. */
const userPrincipal = (user: string): string => {
  const separator = user.indexOf(":");
  return separator === -1 ? user : user.slice(0, separator);
};

const refusal = (input: {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly target: string;
  readonly option: string;
  readonly user: string;
  readonly reason: string;
}): DataTreeOwnershipCapabilityError =>
  new DataTreeOwnershipCapabilityError({
    message: `Service ${input.serviceName} writes to ${input.target} at start, but ${input.reason}`,
    service: input.serviceName,
    serviceType: input.serviceType,
    target: input.target,
    option: input.option,
    user: input.user,
    remediation: `Set services.${input.serviceName}.user to root, to a numeric uid such as "10001", or to a user service type ${input.serviceType} declares.`,
  });

/**
 * Resolves which data trees this service needs prepared in its image.
 *
 * Returns the trees to prepare, an empty list when the planned user already
 * owns everything it writes to, and a tagged refusal when ownership cannot be
 * established before the provider is asked to do anything.
 */
export const resolveDataTreeOwnership = (input: {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly identity: ServiceImageIdentity | undefined;
  readonly hasCustomImage: boolean;
  readonly trees: ReadonlyArray<DataTreeIntent>;
  readonly plannedUser: string | undefined;
}): DataTreeOwnershipCapabilityError | ReadonlyArray<DataTreeOwnership> => {
  // No planned user means the image runs as its own identity, which owns the
  // tree the image shipped. Nothing to establish and nothing to refuse.
  if (input.plannedUser === undefined || input.trees.length === 0) return [];

  const principal = userPrincipal(input.plannedUser);
  if (ROOT_PRINCIPALS.has(principal)) return [];

  const prepared: Array<DataTreeOwnership> = [];
  for (const tree of input.trees) {
    // A Landofile-supplied image is not the image the service type described,
    // so the owners that type says its image seeds no longer describe it.
    if (!input.hasCustomImage && tree.seededOwners.includes(principal)) continue;
    if (NUMERIC_PRINCIPAL.test(principal)) {
      prepared.push({ target: tree.target, owner: principal });
      continue;
    }
    if (input.hasCustomImage) {
      return refusal({
        serviceName: input.serviceName,
        serviceType: input.serviceType,
        target: tree.target,
        option: `services.${input.serviceName}.image`,
        user: input.plannedUser,
        reason: `its image is supplied by the Landofile, so Lando does not know whether user ${principal} exists inside it.`,
      });
    }
    if (input.identity === undefined) {
      return refusal({
        serviceName: input.serviceName,
        serviceType: input.serviceType,
        target: tree.target,
        option: `services.${input.serviceName}.type`,
        user: input.plannedUser,
        reason: `service type ${input.serviceType} declares no image identities, so Lando does not know whether user ${principal} exists inside it.`,
      });
    }
    if (input.identity.homes[principal] === undefined) {
      return refusal({
        serviceName: input.serviceName,
        serviceType: input.serviceType,
        target: tree.target,
        option: `services.${input.serviceName}.user`,
        user: input.plannedUser,
        reason: `service type ${input.serviceType} does not declare user ${principal}, so Lando cannot give that user the tree.`,
      });
    }
    prepared.push({ target: tree.target, owner: principal });
  }
  return prepared;
};

export const DATA_TREE_OWNERSHIP_STEP_ID = "lando.storage:own-data-trees" as const;

/**
 * The single root build step that prepares every resolved tree.
 *
 * It runs during the image build, not as PID 1, so the planned user never
 * needs write permission anywhere to get it. Both the path and the principal
 * are single-quoted: a container path and a container user are validated
 * shapes, and quoting keeps the rendered `RUN` a single shell word each.
 */
export const dataTreeOwnershipStep = (
  trees: ReadonlyArray<DataTreeOwnership>,
): ServiceBuildStepIntent | undefined => {
  if (trees.length === 0) return undefined;
  const commands = trees.flatMap((tree) => [
    `mkdir -p '${tree.target}'`,
    `chown -R '${tree.owner}' '${tree.target}'`,
    `chmod 0770 '${tree.target}'`,
  ]);
  return {
    id: DATA_TREE_OWNERSHIP_STEP_ID,
    phase: "prebuild",
    user: "root",
    command: ["sh", "-c", ["set -eu", ...commands].join("; ")],
  };
};
