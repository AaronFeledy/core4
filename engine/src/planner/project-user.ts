/**
 * Project-user resolution.
 *
 * A project user is the in-container identity whose files belong to the host
 * user on a provider that maps one container id to the host user. Exactly one
 * identity per service can be mapped, so a service has at most one, and the
 * plan records it only when the provider can realize it. Everything else is an
 * explicit explanation that info and lint can show instead of guessing.
 */
import { type CapabilityError, LandofileValidationError } from "@lando/sdk/errors";
import type {
  MountPlan,
  ProjectUserExplanation,
  ProviderCapabilities,
  ProviderId,
  ServiceConfig,
  ServiceProjectUser,
} from "@lando/sdk/schema";
import { validationIssue } from "@lando/sdk/schema";
import type { ServiceImageIdentity } from "@lando/sdk/services";

import { missingCapability } from "./compose-capabilities.ts";

const NUMERIC_PAIR = /^([0-9]+):([0-9]+)$/u;

export interface ResolvedProjectUser {
  readonly projectUser?: ServiceProjectUser;
  readonly explanation?: ProjectUserExplanation;
}

export interface ResolveProjectUserInput {
  readonly appKind: "user" | "global" | "scratch";
  readonly serviceName: string;
  readonly serviceTypeLabel: string;
  readonly appRoot: string;
  readonly provider: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Authored `projectUser:` value; `undefined` means resolve implicitly. */
  readonly authored: ServiceConfig["projectUser"];
  /** Authored process `user:`; features and defaults do not participate. */
  readonly authoredUser: string | undefined;
  /** Whether the finalized mounts include the app-source bind. */
  readonly appSourceMounted: boolean;
  /** The service type's image identities, absent for a Landofile-supplied image. */
  readonly identity: ServiceImageIdentity | undefined;
}

const explanation = (
  state: ProjectUserExplanation["state"],
  explicit: boolean,
  detail: string,
): ResolvedProjectUser => ({ explanation: { state, explicit, detail } });

const isRootIdentity = (user: ServiceProjectUser): boolean => user.uid === 0 || user.name === "root";

const numericIdentity = (uid: string, gid: string): ServiceProjectUser => ({
  name: uid,
  uid: Number(uid),
  gid: Number(gid),
});

const invalidAuthoring = (
  input: ResolveProjectUserInput,
  value: string,
  reason: string,
  remediation: string,
): LandofileValidationError => {
  const message = `services.${input.serviceName}.projectUser has an unsupported value "${value}": ${reason}`;
  return new LandofileValidationError({
    file: `${input.appRoot}/.lando.yml`,
    message,
    issues: [validationIssue(["services", input.serviceName, "projectUser"], message)],
    remediation,
  });
};

const unsupported = (
  input: ResolveProjectUserInput,
  explicit: boolean,
): CapabilityError | ResolvedProjectUser =>
  explicit
    ? missingCapability(
        input.provider,
        input.serviceName,
        "project user mapping",
        "projectUserMapping",
        `Set services.${input.serviceName}.projectUser to false to keep running as the container default, or choose a provider that maps one container id to the host user (rootless Podman or the managed Lando runtime on Linux).`,
      )
    : explanation(
        "provider-unsupported",
        false,
        `Provider ${String(input.provider)} does not map one container id to the host user, so the service keeps the container default identity.`,
      );

/**
 * Resolves a service's project user from the authored values, the service
 * type's image identity, and the provider facts.
 *
 * Explicit authoring is fail-closed: an unsupported provider or an invalid
 * value fails planning. An implicit catalog default never fails; the caller
 * gets an explanation instead so today's behavior is kept.
 */
export const resolveProjectUser = (
  input: ResolveProjectUserInput,
): LandofileValidationError | CapabilityError | ResolvedProjectUser => {
  const explicit = input.authored !== undefined;
  if (input.appKind !== "user")
    return explanation("not-applicable", explicit, "The project user applies only to user apps.");
  if (!input.appSourceMounted)
    return explanation(
      "not-applicable",
      explicit,
      "The service does not mount the app source, so it has no host content to own.",
    );
  if (input.authored === false)
    return explanation(
      "opted-out",
      true,
      "The Landofile explicitly opts this service out of a project user.",
    );

  let candidate: ServiceProjectUser | undefined;
  if (typeof input.authored === "string") {
    const pair = NUMERIC_PAIR.exec(input.authored);
    if (pair !== null) {
      candidate = numericIdentity(pair[1] ?? "", pair[2] ?? "");
    } else {
      const declared = input.identity?.projectUser;
      if (declared === undefined)
        return invalidAuthoring(
          input,
          input.authored,
          `service type ${input.serviceTypeLabel} declares no project user name, so only a numeric uid:gid pair is accepted.`,
          'Set projectUser to a numeric "<uid>:<gid>" pair, or remove it.',
        );
      if (input.authored !== declared.name)
        return invalidAuthoring(
          input,
          input.authored,
          `only the declared name "${declared.name}" or a numeric "<uid>:<gid>" pair is accepted.`,
          `Set projectUser to "${declared.name}" or a numeric "<uid>:<gid>" pair.`,
        );
      candidate = declared;
    }
  } else {
    const declared = input.identity?.projectUser;
    const authored = input.authoredUser;
    if (authored === "root" || authored === "0")
      return explanation(
        "unresolved",
        false,
        "The service runs as root, and root processes keep their own identity.",
      );
    const pair = authored === undefined ? null : NUMERIC_PAIR.exec(authored);
    if (pair !== null) {
      candidate = numericIdentity(pair[1] ?? "", pair[2] ?? "");
    } else if (authored !== undefined && authored === declared?.name) {
      candidate = declared;
    } else {
      candidate = declared;
    }
  }

  if (candidate === undefined || isRootIdentity(candidate))
    return explanation(
      "unresolved",
      false,
      `No non-root project user could be resolved for this service type${input.authoredUser === undefined ? "" : ` and authored user "${input.authoredUser}"`}.`,
    );
  if (input.capabilities.projectUserMapping !== "userns-keep-id") return unsupported(input, explicit);
  return { projectUser: candidate };
};

/**
 * Volume mounts whose fresh store the project user must own after the image
 * seeds it. The home store is prepared separately and authored `storage:`
 * mounts own their declared identity. An exclude shadow is included: on a
 * provider without file-sync it starts empty, and the project user must be
 * able to create in it.
 */
export const projectUserVolumeTrees = (input: {
  readonly mounts: ReadonlyArray<MountPlan>;
  readonly projectUser?: ServiceProjectUser;
  readonly homeStore?: string | undefined;
}): ReadonlyArray<{ readonly target: string; readonly owner: string }> => {
  const projectUser = input.projectUser;
  if (projectUser === undefined) return [];
  const owner = `${projectUser.uid}:${projectUser.gid}`;
  return input.mounts.flatMap((mount) => {
    if (mount.type !== "volume" || mount.origin !== "derived") return [];
    if (mount.store === input.homeStore) return [];
    return [{ target: mount.target, owner }];
  });
};

/**
 * Gives tmpfs mounts the project user's ids and a writable group mode unless
 * the mount already declares that option. Authored options are preserved.
 */
export const projectUserTmpfsMounts = <M extends MountPlan>(
  mounts: ReadonlyArray<M>,
  projectUser: ServiceProjectUser | undefined,
): ReadonlyArray<M> => {
  if (projectUser === undefined) return [...mounts];
  return mounts.map((mount) => {
    if (mount.type !== "tmpfs") return mount;
    const existing = mount.options?.split(",").map((option) => option.trim()) ?? [];
    const has = (name: string): boolean => existing.some((option) => option.startsWith(`${name}=`));
    const additions = [
      ...(has("uid") ? [] : [`uid=${projectUser.uid}`]),
      ...(has("gid") ? [] : [`gid=${projectUser.gid}`]),
      ...(has("mode") ? [] : ["mode=0770"]),
    ];
    if (additions.length === 0) return mount;
    return { ...mount, options: [...existing.filter((option) => option.length > 0), ...additions].join(",") };
  });
};
