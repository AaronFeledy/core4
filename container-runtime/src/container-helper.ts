/**
 * Shared facts about the static in-container helper executable. One Go binary
 * per Linux architecture, bind-mounted read-only at creation, serves the
 * host-proxy client (`lando`), provider log-file follow (`log-file`), the
 * supervised exec process tree (`exec-run`), and the scaffold engine exposed as
 * stable PATH commands `/usr/local/bin/lando-create-project`,
 * `/usr/local/bin/lando-drupal-scaffold`, and
 * `/usr/local/bin/lando-drupal-cms-scaffold`.
 *
 * The directory mount is stable above content-addressed helper versions. Every
 * service also gets the three command mounts, which bind immutable per-architecture
 * shims that execute the current helper through that mounted directory: the binary
 * is static and image-independent, the command uses its own service's Composer when
 * it runs, and gating on an authored type string would break a custom-imaged service
 * that declares the tooling.
 */

import { basename, dirname, join, relative } from "node:path";
import type { ContainerHelperArtifact } from "@lando/sdk/schema";

export const CONTAINER_HELPER_FILE = "lando-container-helper";
const CONTAINER_HELPER_TARGET = "/run/lando/helper";

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
