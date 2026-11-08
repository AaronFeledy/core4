/**
 * Shared facts about the static in-container helper executable. One Go binary
 * per Linux architecture, bind-mounted read-only at creation, serves three
 * roles: invoked as `lando` it is the host-proxy client; `log-file` reads log
 * files for provider file-log follow; `exec-run` owns a supervised exec's
 * process tree.
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
