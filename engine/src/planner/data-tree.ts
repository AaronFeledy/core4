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
import { posix } from "node:path";
import { DataTreeOwnershipCapabilityError } from "@lando/sdk/errors";
import {
  type MountPlan,
  type ServiceProjectUser,
  parseContainerDestination,
  serviceAppMount,
} from "@lando/sdk/schema";
import type { ServiceBuildStepIntent, ServiceImageIdentity } from "@lando/sdk/services";
import { quoteShellPath } from "../services/shell-quote.ts";

/** One mounted tree a service writes to, and the owners its image already seeds. */
interface DataTreeIntent {
  /** Container path the data store is mounted at. */
  readonly target: string;
  /**
   * Principals the image already gives ownership of this target. A fresh
   * volume inherits that ownership, so these need no preparation.
   */
  readonly seededOwners: ReadonlyArray<string>;
}

/** A tree that has to be prepared in the image, and the principal to give it to. */
interface DataTreeOwnership {
  readonly target: string;
  readonly owner: string;
  readonly mountParents?: ReadonlyArray<string>;
  /** An app tree another service may serve, such as an nginx edge, stays readable to it. */
  readonly shared?: boolean;
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
      // Keep both ids when the author supplied them: `chown 1000` would pick a
      // fresh group while `chown 1000:1001` preserves the authored pair.
      prepared.push({ target: tree.target, owner: input.plannedUser });
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
    if (!Object.hasOwn(input.identity.homes, principal)) {
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

const nestedTarget = (tree: string, target: string): string | undefined => {
  const parent = parseContainerDestination(tree);
  const child = parseContainerDestination(target);
  return parent.ok && child.ok && child.value.startsWith(`${parent.value}/`) ? child.value : undefined;
};

/**
 * A fresh volume copies up the image tree with ownership intact. Prepare
 * nested mount parents there so the runtime does not create them as root.
 * An exclude shadow and authored storage enclosing the app bind are both
 * project-user write targets; a home the catalog already prepares is skipped.
 */
export const projectUserVolumeTrees = (input: {
  readonly mounts: ReadonlyArray<MountPlan>;
  readonly projectUser?: ServiceProjectUser;
  readonly homeStore?: string | undefined;
}): ReadonlyArray<DataTreeOwnership> => {
  const { mounts, projectUser, homeStore } = input;
  if (projectUser === undefined) return [];
  const owner = `${projectUser.uid}:${projectUser.gid}`;
  const appMount = serviceAppMount(input);
  return mounts.flatMap((mount) => {
    if (mount.type !== "volume" || mount.store === homeStore) return [];
    const enclosesApp =
      mount.origin === "authored" &&
      appMount !== undefined &&
      nestedTarget(mount.target, appMount.target) !== undefined;
    if (mount.origin !== "derived" && !enclosesApp) return [];
    const parents = new Set<string>();
    for (const other of mounts) {
      const child = nestedTarget(mount.target, other.target);
      if (child !== undefined) parents.add(posix.dirname(child));
    }
    return [
      {
        target: mount.target,
        owner,
        ...(parents.size === 0 ? {} : { mountParents: [...parents] }),
        ...(enclosesApp ? { shared: true } : {}),
      },
    ];
  });
};

export const DATA_TREE_OWNERSHIP_STEP_ID = "lando.storage:own-data-trees" as const;

/**
 * The single root build step that prepares every resolved tree.
 *
 * It runs during the image build, not as PID 1, so the planned user never
 * needs write permission anywhere to get it. Both the path and the principal
 * are single-quoted: a container path and a container user are validated
 * shapes, and quoting keeps the rendered `RUN` a single shell word each.
 *
 * `phase` is `"build"` because derived-image materialization (`parseStep` in
 * `@lando/container-runtime`) drops every other phase.
 */
export const dataTreeOwnershipStep = (
  trees: ReadonlyArray<DataTreeOwnership>,
): ServiceBuildStepIntent | undefined => {
  if (trees.length === 0) return undefined;
  // A feature and project-user intent can claim the same target. The first
  // owner wins, but its mkdir still needs the project-user mount parents.
  const parentsByTarget = new Map(
    trees.flatMap((tree) =>
      tree.mountParents === undefined ? [] : [[tree.target, tree.mountParents] as const],
    ),
  );
  const seen = new Set<string>();
  const commands = trees.flatMap((tree) => {
    if (seen.has(tree.target)) return [];
    seen.add(tree.target);
    const target = quoteShellPath(tree.target);
    const parents = (parentsByTarget.get(tree.target) ?? []).filter((parent) => parent !== tree.target);
    const directories = [target, ...parents.map(quoteShellPath)];
    return [
      `mkdir -p ${directories.join(" ")}`,
      `chown -R '${tree.owner}' ${target}`,
      `chmod ${tree.shared === true ? "0775" : "0770"} ${target}`,
    ];
  });
  return {
    id: DATA_TREE_OWNERSHIP_STEP_ID,
    phase: "build",
    user: "root",
    command: ["sh", "-c", ["set -eu", ...commands].join("; ")],
  };
};
