import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CONTAINER_HELPER_FILE, type ContainerHelperArch } from "@lando/container-runtime/container-helper";
import {
  AGENT_CONTEXT_ENV_ALLOWLIST,
  AGENT_ENV_VALUE_MUST_BE_ONE,
  HOST_PROXY_ENV_NAMES,
  HOST_PROXY_ENV_PREFIXES,
} from "@lando/engine/config/agent-env";
import { HOST_PROXY_RUN_LANDO_ENV_NAMES } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { sha256Hex } from "@lando/sdk/digest";

/** Go module, builder Landofile, and build outputs of the in-container helper. */
export const CONTAINER_HELPER_SOURCE_ROOT = resolve(import.meta.dirname, "../../container-helper");

export const containerHelperDistPath = (arch: ContainerHelperArch): string =>
  join(CONTAINER_HELPER_SOURCE_ROOT, "dist", `linux-${arch}`, CONTAINER_HELPER_FILE);

/** Records the source digest the binaries in `dist/` were built from. */
export const CONTAINER_HELPER_SOURCE_DIGEST_PATH = join(
  CONTAINER_HELPER_SOURCE_ROOT,
  "dist",
  "source-digest",
);

/**
 * Linker flags for `go build`. The forwarded-env policy is injected here so the
 * TypeScript tables stay its only source; the host re-applies the same filter.
 */
export const containerHelperLinkerFlags = (): string =>
  [
    "-s",
    "-w",
    `-X main.forwardPrefixes=${HOST_PROXY_ENV_PREFIXES.join(",")}`,
    `-X main.forwardNames=${[...HOST_PROXY_ENV_NAMES, ...AGENT_CONTEXT_ENV_ALLOWLIST].join(",")}`,
    `-X main.blockedNames=${HOST_PROXY_RUN_LANDO_ENV_NAMES.join(",")}`,
    `-X main.mustBeOneNames=${[...AGENT_ENV_VALUE_MUST_BE_ONE].join(",")}`,
  ].join(" ");

const isBuildInput = (name: string): boolean =>
  name === "go.mod" || name === ".lando.yml" || (name.endsWith(".go") && !name.endsWith("_test.go"));

/** Digest of everything that determines the built binaries: Go sources, toolchain image, and linker flags. */
export const containerHelperSourceDigest = async (): Promise<string> => {
  const names = (await readdir(CONTAINER_HELPER_SOURCE_ROOT)).filter(isBuildInput).sort();
  const parts = ["notices-v1", `ldflags\0${containerHelperLinkerFlags()}`];
  for (const name of names) {
    parts.push(`${name}\0${await readFile(join(CONTAINER_HELPER_SOURCE_ROOT, name), "utf8")}`);
  }
  return sha256Hex(parts.join("\0"));
};
