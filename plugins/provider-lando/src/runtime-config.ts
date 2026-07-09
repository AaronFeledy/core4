import { mkdir, writeFile } from "node:fs/promises";

import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

const PROVIDER_ID = "lando";
const OPERATION = "setup";

export interface WriteManagedRuntimeContainersConfOptions {
  readonly runtimeBinDir: string;
  readonly runtimeConfigDir: string;
}

const escapeTomlString = (value: string): string => value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');

// Upstream `[network].default_host_ips` defaults to `[]` = bind published ports
// on every interface (0.0.0.0/::); loopback-only keeps managed-runtime bindings
// off the LAN. Field/shape/example per container-libs (Podman 6.0.0, common
// v0.68.0): config.go DefaultHostIPs `toml:"default_host_ips,omitempty"` and
// docs/containers.conf.5.md (example `["127.0.0.1", "::1"]`).
const MANAGED_DEFAULT_HOST_IPS = ["127.0.0.1", "::1"] as const;

const containersConfBody = (runtimeBinDir: string): string => {
  const defaultHostIps = MANAGED_DEFAULT_HOST_IPS.map((ip) => `"${ip}"`).join(", ");
  return (
    `[engine]\nhelper_binaries_dir = ["${escapeTomlString(runtimeBinDir)}"]\n` +
    `[network]\ndefault_host_ips = [${defaultHostIps}]\n`
  );
};

export const writeManagedRuntimeContainersConf = (
  options: WriteManagedRuntimeContainersConfOptions,
): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(options.runtimeConfigDir, { recursive: true });
      await writeFile(
        `${options.runtimeConfigDir.replace(/\/+$/u, "")}/containers.conf`,
        containersConfBody(options.runtimeBinDir),
      );
    },
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: PROVIDER_ID,
        operation: OPERATION,
        message: "Failed to write the Lando managed runtime containers.conf.",
        remediation: "Verify the Lando runtime config directory is writable, then rerun `lando setup`.",
        cause,
      }),
  });
