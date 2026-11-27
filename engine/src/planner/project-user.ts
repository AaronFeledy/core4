/**
 * Project-user resolution.
 *
 * A project user is the in-container identity whose files belong to the host
 * user on a provider that maps one container id to the host user. Exactly one
 * identity per service can be mapped, so a service has at most one, and the
 * plan records it only when the provider can realize it. Everything else is an
 * explicit explanation that info and lint can show instead of guessing.
 */
import { CapabilityError, LandofileValidationError } from "@lando/sdk/errors";
import type {
  MountPlan,
  ProjectUserExplanation,
  ProviderCapabilities,
  ProviderId,
  ServiceConfig,
  ServiceProjectUser,
} from "@lando/sdk/schema";
import { validationIssue } from "@lando/sdk/schema";
import type { ServiceBuildStepIntent, ServiceImageIdentity } from "@lando/sdk/services";

import { projectUserMappingCapabilityError } from "./resource-capabilities.ts";

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
  /** The final command opted in and still uses the stock image's entrypoint. */
  readonly stockLauncher: boolean;
  /** Composed process user, used to check launcher-scoped defaults. */
  readonly processUser: string | undefined;
  /** Whether the finalized mounts include the app-source bind. */
  readonly appSourceMounted: boolean;
  /** The service type's image identities, absent for a Landofile-supplied image. */
  readonly identity: ServiceImageIdentity | undefined;
  /** Invoking host ids, needed when the engine realizes the mapping by renumbering. */
  readonly host?: { readonly uid: string; readonly gid: string } | undefined;
}

const explanation = (
  state: ProjectUserExplanation["state"],
  explicit: boolean,
  detail: string,
): ResolvedProjectUser => ({ explanation: { state, explicit, detail } });

const isRootIdentity = (user: ServiceProjectUser): boolean => user.uid === 0 || user.name === "root";

/** The principal of a `user:` value, without its optional group suffix. */
const userPrincipal = (user: string): string => {
  const separator = user.indexOf(":");
  return separator === -1 ? user : user.slice(0, separator);
};

const isRootPrincipal = (user: string): boolean => {
  const principal = userPrincipal(user);
  return principal === "root" || principal === "0";
};

const numericIdentity = (uid: string, gid: string): ServiceProjectUser => ({
  name: uid,
  uid: Number(uid),
  gid: Number(gid),
});

const NUMERIC_ID = /^[0-9]+$/u;
const MAX_CONTAINER_ID = 4_294_967_295;

/** Host ids as numbers, or undefined when the process could not report usable ids. */
const hostIdentity = (host: ResolveProjectUserInput["host"]): { uid: number; gid: number } | undefined => {
  if (host === undefined || !NUMERIC_ID.test(host.uid) || !NUMERIC_ID.test(host.gid)) return undefined;
  const uid = Number(host.uid);
  const gid = Number(host.gid);
  return uid > MAX_CONTAINER_ID || gid > MAX_CONTAINER_ID ? undefined : { uid, gid };
};

/** The numeric `user:` pair an author configured, which a custom image can reuse. */
const configuredNumericUser = (user: string | undefined): ServiceProjectUser | undefined => {
  if (user === undefined) return undefined;
  const pair = NUMERIC_PAIR.exec(user);
  return pair === null ? undefined : numericIdentity(pair[1] ?? "", pair[2] ?? "");
};

type NumericIds = Pick<ServiceProjectUser, "uid" | "gid">;

const sameNumericIds = (actual: NumericIds | undefined, expected: NumericIds): boolean =>
  actual?.uid === expected.uid && actual.gid === expected.gid;

const invalidAuthoring = (
  input: ResolveProjectUserInput,
  value: string,
  reason: string,
  remediation: string,
): LandofileValidationError => {
  const message = `services.${input.serviceName}.projectUser has an unsupported value "${value}": ${reason}`;
  return new LandofileValidationError({
    file: input.appRoot,
    message,
    issues: [validationIssue(["services", input.serviceName, "projectUser"], message)],
    remediation,
  });
};

const unsupportedDetail = (input: ResolveProjectUserInput): string => {
  if (input.capabilities.bindOwnership === "root-is-host-user")
    return "This engine maps only container root to the host user, so a non-root project user would be a subordinate id.";
  if (input.capabilities.bindOwnership === "userns-remap")
    return "This engine remaps container ids through a daemon user namespace, so no container id is the host user.";
  if (input.capabilities.bindOwnership === "unknown")
    return `Lando cannot tell how provider ${String(input.provider)} maps container ids to host ids, so the service keeps the container default identity.`;
  return `Provider ${String(input.provider)} does not map one container id to the host user, so the service keeps the container default identity.`;
};

const unsupported = (
  input: ResolveProjectUserInput,
  explicit: boolean,
): CapabilityError | ResolvedProjectUser =>
  (explicit
    ? projectUserMappingCapabilityError(input.provider, input.capabilities, input.serviceName)
    : undefined) ?? explanation("provider-unsupported", false, unsupportedDetail(input));

const mappingRefusal = (
  input: ResolveProjectUserInput,
  message: string,
  remediation: string,
): CapabilityError =>
  new CapabilityError({
    message,
    service: input.serviceName,
    feature: "project user mapping",
    capability: "projectUserMapping",
    providerId: String(input.provider),
    remediation,
  });

/**
 * Realizes a catalog project user by renumbering the image account to the
 * invoking host ids, or a custom image's configured numeric user by creating
 * the container as the host ids.
 */
const resolveImageRenumber = (
  input: ResolveProjectUserInput,
  candidate: ServiceProjectUser,
  explicit: boolean,
  namedNumeric: ServiceProjectUser | undefined,
): CapabilityError | ResolvedProjectUser => {
  const declared = input.identity?.projectUser;
  const launcherPolicy = !explicit && input.identity?.projectUserDefault !== undefined;
  const launcherNumeric = launcherPolicy ? namedNumeric : undefined;
  const processUser = input.processUser;
  if (
    launcherNumeric !== undefined &&
    (!input.stockLauncher ||
      !sameNumericIds(declared, launcherNumeric) ||
      (processUser !== undefined && !sameNumericIds(configuredNumericUser(processUser), launcherNumeric)))
  )
    return explanation(
      "provider-unsupported",
      false,
      "This engine cannot renumber the configured numeric process user on this launcher.",
    );
  const host = hostIdentity(input.host);
  if (host === undefined)
    return explicit
      ? mappingRefusal(
          input,
          `Service ${input.serviceName} cannot map its project user because Lando could not read this host's user ids.`,
          "Run Lando as a regular user whose uid and gid are readable, or set projectUser: false to keep the container identity.",
        )
      : explanation(
          "provider-unsupported",
          false,
          "Lando could not read this host's user ids, so the project user is not renumbered.",
        );
  if (host.uid === 0 || host.gid === 0) {
    const rootId = host.uid === 0 ? "uid" : "gid";
    if (launcherPolicy && launcherNumeric === undefined)
      return explanation(
        "provider-unsupported",
        false,
        `Lando is running with host ${rootId} 0, so the default worker keeps its container identity.`,
      );
    return mappingRefusal(
      input,
      `Service ${input.serviceName} cannot map its project user because Lando is running with host ${rootId} 0.`,
      "Run Lando as your own user instead of with sudo; root cannot be renumbered to a non-root project user.",
    );
  }
  // The image build can move a named account, but it cannot change an
  // authored numeric process user that will still run with its original ids.
  if (launcherNumeric !== undefined && !sameNumericIds(host, launcherNumeric))
    return explanation(
      "provider-unsupported",
      false,
      "This engine cannot map a numeric process user that does not already use the host ids.",
    );
  if (input.identity !== undefined) {
    if (declared === undefined)
      return explicit
        ? mappingRefusal(
            input,
            `Service ${input.serviceName} cannot map its project user because service type ${input.serviceTypeLabel} declares none to renumber.`,
            `Set services.${input.serviceName}.projectUser to false, or choose a provider that maps one container id to the host user.`,
          )
        : explanation(
            "provider-unsupported",
            false,
            `Service type ${input.serviceTypeLabel} declares no project user to renumber on this engine.`,
          );
    const declaresCandidate =
      namedNumeric === undefined ||
      (namedNumeric.uid === declared.uid && namedNumeric.gid === declared.gid) ||
      (namedNumeric.uid === host.uid && namedNumeric.gid === host.gid);
    if (explicit && !declaresCandidate)
      return mappingRefusal(
        input,
        `Service ${input.serviceName} cannot map the numeric project user ${namedNumeric?.name ?? candidate.name} on this engine; it renumbers the catalog account ${declared.name} to the host user.`,
        `Set services.${input.serviceName}.projectUser to "${declared.name}" or "${declared.uid}:${declared.gid}", or to false to keep the container identity.`,
      );
    return {
      projectUser:
        host.uid === declared.uid && host.gid === declared.gid
          ? declared
          : { name: declared.name, uid: host.uid, gid: host.gid },
    };
  }
  const configured = configuredNumericUser(input.authoredUser);
  if (
    namedNumeric === undefined ||
    configured === undefined ||
    namedNumeric.uid !== configured.uid ||
    namedNumeric.gid !== configured.gid
  )
    return explicit
      ? mappingRefusal(
          input,
          `Service ${input.serviceName} cannot map a project user on this engine: its custom image has no catalog account to renumber, and the requested identity is not the configured user.`,
          `Set services.${input.serviceName}.user and services.${input.serviceName}.projectUser to the image's numeric "<uid>:<gid>" pair, or to false to keep the container identity.`,
        )
      : explanation(
          "provider-unsupported",
          false,
          "This engine can map a custom image only when a numeric process user is configured, so the service keeps the container identity.",
        );
  return { projectUser: { name: String(host.uid), uid: host.uid, gid: host.gid } };
};

/**
 * Resolves a service's project user from the authored values, the service
 * type's image identity, and the provider facts.
 *
 * Explicit authoring is fail-closed: an unsupported provider or an invalid
 * value fails planning. An unavailable implicit mapping gets an explanation,
 * unless an eligible image renumber refuses host root. A launcher-scoped
 * catalog fallback keeps the container identity on host root instead.
 */
export const resolveProjectUser = (
  input: ResolveProjectUserInput,
): LandofileValidationError | CapabilityError | ResolvedProjectUser => {
  const explicit = input.authored !== undefined;
  // Explicit grammar is validated before applicability so an invalid value
  // never passes because this service happens to have no app-source mount.
  let explicitCandidate: ServiceProjectUser | undefined;
  if (typeof input.authored === "string") {
    const pair = NUMERIC_PAIR.exec(input.authored);
    if (pair !== null) {
      explicitCandidate = numericIdentity(pair[1] ?? "", pair[2] ?? "");
      if (isRootIdentity(explicitCandidate))
        return invalidAuthoring(
          input,
          input.authored,
          "uid 0 is root, which keeps its own identity instead of mapping to the host user.",
          'Set projectUser to a non-root "<uid>:<gid>" pair, or to false to opt the service out.',
        );
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
      explicitCandidate = declared;
    }
  }
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
  let numericCandidate: ServiceProjectUser | undefined;
  if (typeof input.authored === "string") {
    candidate = explicitCandidate;
    numericCandidate = NUMERIC_PAIR.test(input.authored) ? explicitCandidate : undefined;
  } else {
    const declared = input.identity?.projectUser;
    const authored = input.authoredUser;
    if (authored !== undefined && isRootPrincipal(authored))
      return explanation(
        "unresolved",
        false,
        "The service runs as root, and root processes keep their own identity.",
      );
    numericCandidate = configuredNumericUser(authored);
    const processUser = input.processUser;
    if (numericCandidate !== undefined) {
      candidate = numericCandidate;
    } else if (
      input.identity?.projectUserDefault === undefined ||
      (input.stockLauncher &&
        (authored === undefined || authored === declared?.name) &&
        (processUser === undefined || processUser === declared?.name))
    ) {
      candidate = declared;
    }
  }

  if (candidate === undefined || isRootIdentity(candidate))
    return explanation(
      "unresolved",
      false,
      `No non-root project user could be resolved for this service type${input.authoredUser === undefined ? "" : ` and authored user "${input.authoredUser}"`}.`,
    );
  if (input.capabilities.projectUserMapping === "userns-keep-id") return { projectUser: candidate };
  if (input.capabilities.projectUserMapping === "image-renumber")
    return resolveImageRenumber(input, candidate, explicit, numericCandidate);
  return unsupported(input, explicit);
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
export const projectUserRenumberStepId = "lando.project-user:renumber" as const;

/**
 * The one root build step that renumbers a catalog project account to the
 * invoking host ids in the derived image.
 *
 * The account is found by its declared uid, so a name never has to be
 * shell-quoted. `usermod -o` and `groupmod -o` allow non-unique ids: another
 * image account may already hold the target id, and only the declared project
 * account changes. Existing image files owned by the old ids move with it,
 * while files owned by uid 0 are never touched. The step is emitted only when
 * a project user is realized and the ids differ, and its command carries the
 * ids into the build key.
 */
export const projectUserRenumberStep = (input: {
  readonly identity: ServiceImageIdentity | undefined;
  readonly mapping: ProviderCapabilities["projectUserMapping"];
  readonly projectUser: ServiceProjectUser | undefined;
  readonly host: { readonly uid: string; readonly gid: string } | undefined;
}): ServiceBuildStepIntent | undefined => {
  const declared = input.identity?.projectUser;
  if (input.mapping !== "image-renumber" || declared === undefined || input.projectUser === undefined)
    return undefined;
  const host = hostIdentity(input.host);
  if (host === undefined || host.uid === 0 || host.gid === 0) return undefined;
  if (host.uid === declared.uid && host.gid === declared.gid) return undefined;
  const shadowCommands = [
    `lando_user=$(getent passwd '${declared.uid}' | cut -d: -f1 | head -n1)`,
    'test -n "$lando_user"',
    ...(declared.gid === host.gid ? [] : [`groupmod -o -g '${host.gid}' "$(id -gn "$lando_user")"`]),
    ...(declared.uid === host.uid
      ? [`usermod -g '${host.gid}' "$lando_user"`]
      : [`usermod -o -u '${host.uid}' -g '${host.gid}' "$lando_user"`]),
    // shadow-utils moves the account's lastlog and faillog records to the new
    // uid's offset, which a large host uid turns into a huge sparse file in the
    // derived layer. Emptying the files after usermod keeps the image small.
    ...["/var/log/lastlog", "/var/log/faillog"].map((file) => `test ! -e '${file}' || : > '${file}'`),
  ];
  // Minimal images may not ship shadow-utils. Rewrite only the selected local
  // records, keeping the existing files' metadata and permitting id collisions.
  const localCommands = [
    `lando_user=$(awk -F: '$3 == ${declared.uid} { print $1; exit }' /etc/passwd)`,
    'test -n "$lando_user"',
    ...(declared.gid === host.gid
      ? []
      : [
          `awk 'BEGIN { FS=OFS=":" } !changed && $3 == ${declared.gid} { $3=${host.gid}; changed=1 } { print } END { if (!changed) exit 1 }' /etc/group > "$lando_ids/group"`,
        ]),
    `awk -v user="$lando_user" 'BEGIN { FS=OFS=":" } $1 == user && $3 == ${declared.uid} { $3=${host.uid}; $4=${host.gid} } { print }' /etc/passwd > "$lando_ids/passwd"`,
    ...(declared.gid === host.gid ? [] : ['cat "$lando_ids/group" > /etc/group']),
    'cat "$lando_ids/passwd" > /etc/passwd',
  ];
  const commands = [
    `if command -v usermod >/dev/null && command -v groupmod >/dev/null; then ${shadowCommands.join("; ")}; else lando_ids=$(mktemp -d); trap 'rm -rf "$lando_ids"' EXIT; ${localCommands.join("; ")}; fi`,
    `find / -xdev \\( -user '${declared.uid}' -o -group '${declared.gid}' \\) ! -user 0 -exec chown -h '${host.uid}:${host.gid}' {} +`,
  ];
  return {
    id: projectUserRenumberStepId,
    phase: "build",
    user: "root",
    command: ["sh", "-c", ["set -eu", ...commands].join("; ")],
  };
};
