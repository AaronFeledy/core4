/**
 * Shared facts about the static in-container helper executable. One Go binary
 * per Linux architecture, bind-mounted read-only at creation, serves the
 * host-proxy client (`lando`), provider log-file follow (`log-file`), the
 * supervised exec process tree (`exec-run`), and the scaffold engine exposed as
 * stable PATH commands `/usr/local/bin/lando-create-project`,
 * `/usr/local/bin/lando-drupal-scaffold`, and
 * `/usr/local/bin/lando-drupal-cms-scaffold`.
 */

import { basename, dirname, relative } from "node:path";
import type { ContainerHelperArtifact } from "@lando/sdk/schema";

export const CONTAINER_HELPER_FILE = "lando-container-helper";
const CONTAINER_HELPER_TARGET = "/run/lando/helper";

/** Bind the architecture directory, never its replaceable content-addressed child. */
export const containerHelperDelivery = (helper: ContainerHelperArtifact) => {
  const parent = dirname(helper.path);
  const source = /^[a-f0-9]{64}$/.test(basename(parent)) ? dirname(parent) : parent;
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
 * Bind each command name to the resolved helper executable. Unlike the
 * `/run/lando/helper` directory mount, these read the exact resolved artifact,
 * so a new helper digest changes the create fingerprint and recreates the
 * container instead of leaving a stale scaffold engine on PATH.
 */
export const containerHelperCommandMounts = (helper: ContainerHelperArtifact) =>
  CONTAINER_HELPER_COMMANDS.map((name) => ({
    source: helper.path,
    target: `/usr/local/bin/${name}`,
  }));
