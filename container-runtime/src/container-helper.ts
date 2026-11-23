/**
 * Shared facts about the static in-container helper executable. One Go binary
 * per Linux architecture, bind-mounted read-only at creation, serves the
 * host-proxy client (`lando`), provider log-file follow (`log-file`), the
 * supervised exec process tree (`exec-run`), and the scaffold engine exposed as
 * stable PATH commands `/usr/local/bin/lando-create-project`,
 * `/usr/local/bin/lando-drupal-scaffold`, `/usr/local/bin/lando-drupal-cms-scaffold`,
 * and `/usr/local/bin/lando-drupal-contrib-sync`.
 *
 * It also carries the login-profile hook that keeps a service's PATH in login
 * shells; see `CONTAINER_HELPER_PROFILE_STUB` and `CONTAINER_HELPER_PROFILE_HOOK`.
 *
 * The directory mount is stable above content-addressed helper versions. Every
 * service also gets the four command mounts, which bind immutable per-architecture
 * shims that execute the current helper through that mounted directory: the binary
 * is static and image-independent, the command uses its own service's Composer when
 * it runs, and gating on an authored type string would break a custom-imaged service
 * that declares the tooling.
 */

import { basename, dirname, join, relative } from "node:path";
import { type ContainerHelperArtifact, type MountPlan, mountTargetCovers } from "@lando/sdk/schema";

export const CONTAINER_HELPER_FILE = "lando-container-helper";
export const CONTAINER_HELPER_TARGET = "/run/lando/helper";

/** The directory a provider bind-mounts at `CONTAINER_HELPER_TARGET`. */
export const containerHelperDirectory = (helper: ContainerHelperArtifact): string => {
  const parent = dirname(helper.path);
  return /^[a-f0-9]{64}$/u.test(basename(parent)) ? dirname(parent) : parent;
};

/**
 * Bind the architecture directory, never its replaceable content-addressed child.
 * A new digest appears inside the mounted directory, so the mount source and the
 * create fingerprint stay stable.
 */
export const containerHelperDelivery = (helper: ContainerHelperArtifact) => {
  const source = containerHelperDirectory(helper);
  return {
    source,
    target: CONTAINER_HELPER_TARGET,
    executable: `${CONTAINER_HELPER_TARGET}/${relative(source, helper.path).replaceAll("\\", "/")}`,
  };
};

export type ContainerHelperArch = "x64" | "arm64";

export const CONTAINER_HELPER_ARCHES: ReadonlyArray<ContainerHelperArch> = ["x64", "arm64"];

/** Go `GOARCH` for each helper architecture. */
export const containerHelperGoArch = (arch: ContainerHelperArch): "amd64" | "arm64" =>
  arch === "x64" ? "amd64" : "arm64";

export const logFileHelperExecArgv = (helperPath: string): ReadonlyArray<string> => [helperPath, "log-file"];

/** Stable command names the helper dispatches on argv[0]. */
export const CONTAINER_HELPER_COMMANDS = [
  "lando-create-project",
  "lando-drupal-scaffold",
  "lando-drupal-cms-scaffold",
  "lando-drupal-contrib-sync",
] as const;

export const CONTAINER_HELPER_COMMAND_TARGETS: ReadonlySet<string> = new Set(
  CONTAINER_HELPER_COMMANDS.map((name) => `/usr/local/bin/${name}`),
);

/**
 * Stable exec-time delivery for the scaffold commands. `resolveContainerHelper`
 * publishes two per-architecture sets inside the mounted directory:
 *
 * - `shims/<name>` is an immutable shell shim, bound at `/usr/local/bin/<name>`.
 *   Its source path never changes, so a helper update never changes a service's
 *   create fingerprint and never recreates a container.
 * - `engines/<name>` is a hard link to the helper current for this architecture.
 *   The shim executes `/run/lando/helper/engines/<name>` by container path, so
 *   the kernel resolves the current engine at exec time, including inside a
 *   running container that was created before the update.
 *
 * `exec-run`, `log-file`, and the host-proxy role still run the digest-addressed
 * artifact, so Lando always drives the helper it resolved.
 */
const CONTAINER_HELPER_COMMAND_SHIMS = "shims";
const CONTAINER_HELPER_COMMAND_ENGINES = "engines";

// Native healthchecks store argv at create time, before any particular helper
// digest is known. Resolve the current binary inside the existing directory mount.
export const CONTAINER_HELPER_PROBE_EXECUTABLE = `${CONTAINER_HELPER_TARGET}/${CONTAINER_HELPER_COMMAND_ENGINES}/${CONTAINER_HELPER_FILE}`;

export const containerHelperCommandMount = (helper: ContainerHelperArtifact, name: string): string =>
  join(containerHelperDirectory(helper), CONTAINER_HELPER_COMMAND_SHIMS, name);

/** The container path the shim executes; the helper dispatches on its basename. */
export const containerHelperCommandEngine = (name: string): string =>
  `${CONTAINER_HELPER_TARGET}/${CONTAINER_HELPER_COMMAND_ENGINES}/${name}`;

export const containerHelperCommandShim = (name: string): string =>
  `#!/bin/sh\n# Lando scaffold engine shim: execute the current helper for this architecture.\nexec ${containerHelperCommandEngine(name)} "$@"\n`;

export const containerHelperCommandEnginePath = (helper: ContainerHelperArtifact, name: string): string =>
  join(containerHelperDirectory(helper), CONTAINER_HELPER_COMMAND_ENGINES, name);

export const containerHelperCommandMounts = (helper: ContainerHelperArtifact) =>
  CONTAINER_HELPER_COMMANDS.map((name) => ({
    source: containerHelperCommandMount(helper, name),
    target: `/usr/local/bin/${name}`,
  }));

/**
 * The mount strictly above a Lando file bind such as `/usr/local/bin/<name>` or the
 * login-profile stub that owns that directory. Binding beneath a bind or volume
 * would create an empty mountpoint file in that mount's source, so the Lando bind
 * is skipped instead. A tmpfs persists nothing, so a bind beneath it still mounts.
 * An exact target is a collision, not a cover.
 */
export const helperBindCoveredBy = (
  mounts: ReadonlyArray<MountPlan>,
  target: string,
): MountPlan | undefined =>
  mounts.find(
    (mount) =>
      mount.type !== "tmpfs" &&
      mountTargetCovers(mount.target, target) &&
      !mountTargetCovers(target, mount.target),
  );

/**
 * Why `mount` cannot coexist with the helper binds every service receives, or
 * undefined. The helper directory is mandatory: a mount at it or beneath it would
 * shadow or nest inside it, and a bind or volume above it would gain Lando's
 * mountpoints in its source. A tmpfs above it (`/run` on a read-only service)
 * persists nothing, so the helper mounts beneath it. A mount at a helper command
 * target would replace that command. Planning and lint refuse these; providers
 * repeat the check for plans that did not come from the planner.
 */
export const reservedHelperTargetConflict = (
  serviceName: string,
  mount: Pick<MountPlan, "type" | "target">,
): { readonly message: string; readonly remediation: string } | undefined => {
  if (
    mountTargetCovers(CONTAINER_HELPER_TARGET, mount.target) ||
    (mount.type !== "tmpfs" && mountTargetCovers(mount.target, CONTAINER_HELPER_TARGET))
  )
    return {
      message: `Service ${serviceName} mounts ${mount.target}, which overlaps Lando's reserved helper directory ${CONTAINER_HELPER_TARGET}.`,
      remediation: `Move the mount at ${mount.target} to a path that is neither above nor inside ${CONTAINER_HELPER_TARGET}.`,
    };
  for (const target of CONTAINER_HELPER_COMMAND_TARGETS)
    if (mountTargetCovers(target, mount.target) && mountTargetCovers(mount.target, target))
      return {
        message: `Service ${serviceName} mounts ${mount.target}, which is reserved for Lando's ${basename(target)} command.`,
        remediation: `Move the mount at ${mount.target} to another path.`,
      };
  return undefined;
};

/**
 * Distro login profiles (`/etc/profile` on Debian, Alpine, and RHEL) reset PATH,
 * so a login shell loses what `lando exec` sees: an authored PATH and the image's
 * own entries such as `/usr/local/go/bin`. Sourced through the profile stub,
 * after the other `/etc/profile.d` scripts, this hook reads the PATH the shell was started with from its initial
 * environment, keeps it verbatim, and appends each entry the profiles added that
 * it lacks. User dotfiles run later and can still prepend. It changes no shell
 * option or IFS, needs only `tr`, and does nothing when that PATH is unreadable,
 * empty, or holds a newline, or when PATH is readonly.
 */
export const CONTAINER_HELPER_PROFILE_HOOK = `# Lando: login profiles reset PATH. Restore the PATH this shell started with,
# then append the entries the profiles added.
__lando_soh=$(printf '\\001')
__lando_path=$(tr '\\n\\000' '\\001\\n' 2>/dev/null <"/proc/$$/environ" | while IFS= read -r __lando_record; do
  case $__lando_record in
    PATH=*)
      printf '%s' "\${__lando_record#PATH=}"
      break
      ;;
  esac
done) || :
case $__lando_path in
  "" | *"$__lando_soh"*) ;;
  *)
    if (PATH=$__lando_path) 2>/dev/null; then
      __lando_merged=$__lando_path
      __lando_rest=\${PATH-}:
      while [ -n "$__lando_rest" ]; do
        __lando_entry=\${__lando_rest%%:*}
        __lando_rest=\${__lando_rest#*:}
        if [ -n "$__lando_entry" ]; then
          case :$__lando_merged: in
            *":$__lando_entry:"*) ;;
            *) __lando_merged=$__lando_merged:$__lando_entry ;;
          esac
        fi
      done
      PATH=$__lando_merged
      export PATH
    fi
    ;;
esac
unset __lando_soh __lando_path __lando_record __lando_merged __lando_rest __lando_entry
`;

/** Where every service sources the stub; the `zz-` prefix orders it after other profile scripts. */
export const CONTAINER_HELPER_PROFILE_TARGET = "/etc/profile.d/zz-lando-service-path.sh";

const CONTAINER_HELPER_PROFILE = "profile";
const CONTAINER_HELPER_PROFILE_HOOK_FILE = "service-path.sh";

/** The container path of the hook body inside the mounted helper directory. */
export const CONTAINER_HELPER_PROFILE_HOOK_TARGET = `${CONTAINER_HELPER_TARGET}/${CONTAINER_HELPER_PROFILE}/${CONTAINER_HELPER_PROFILE_HOOK_FILE}`;

/**
 * The immutable file bound at `CONTAINER_HELPER_PROFILE_TARGET`. Like the command
 * shims, its source never changes, so a hook update never changes a create
 * fingerprint; it sources the current body through the helper directory mount, so
 * running containers pick up a new body at their next login.
 */
export const CONTAINER_HELPER_PROFILE_STUB = `# Lando: keep the service PATH in login shells; the body ships with the helper.
if [ -r ${CONTAINER_HELPER_PROFILE_HOOK_TARGET} ]; then
  . ${CONTAINER_HELPER_PROFILE_HOOK_TARGET}
fi
`;

/** The host path of the stub, bound read-only at `CONTAINER_HELPER_PROFILE_TARGET`. */
export const containerHelperProfileStubPath = (helper: ContainerHelperArtifact): string =>
  join(containerHelperDirectory(helper), CONTAINER_HELPER_PROFILE, basename(CONTAINER_HELPER_PROFILE_TARGET));

/** The host path of the hook body, replaced atomically when its bytes change. */
export const containerHelperProfileHookPath = (helper: ContainerHelperArtifact): string =>
  join(containerHelperDirectory(helper), CONTAINER_HELPER_PROFILE, CONTAINER_HELPER_PROFILE_HOOK_FILE);
