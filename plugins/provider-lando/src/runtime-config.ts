import { mkdir, writeFile } from "node:fs/promises";

import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

export interface WriteManagedRuntimeContainersConfOptions {
  readonly runtimeBinDir: string;
  readonly runtimeConfigDir: string;
}

const escapeTomlString = (value: string): string => value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');

// Podman's empty default binds published ports on every interface; loopback-only
// keeps managed-runtime bindings off the LAN.
const MANAGED_DEFAULT_HOST_IPS = ["127.0.0.1", "::1"] as const;
const MANAGED_REGISTRIES_CONF = 'unqualified-search-registries = ["docker.io"]\n';
const MANAGED_SIGNATURE_POLICY = `{
  "default": [
    {
      "type": "insecureAcceptAnything"
    }
  ],
  "transports": {
    "docker-daemon": {
      "": [
        {
          "type": "insecureAcceptAnything"
        }
      ]
    }
  }
}
`;

export const writeManagedRuntimeContainersConf = (
  options: WriteManagedRuntimeContainersConfOptions,
): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const defaultHostIps = MANAGED_DEFAULT_HOST_IPS.map((ip) => `"${ip}"`).join(", ");
      const binDir = escapeTomlString(options.runtimeBinDir);
      // Pin conmon and the crun OCI runtime to the bundled binaries: host copies
      // (e.g. a pre-Podman-6 crun on CI runners) fail container start with
      // "crun: unknown version specified". log_driver stays k8s-file because the
      // bundled static conmon has no journald support.
      const body = `[containers]\nlog_driver = "k8s-file"\n[engine]\nhelper_binaries_dir = ["${binDir}"]\nconmon_path = ["${binDir}/conmon"]\nruntime = "crun"\n[engine.runtimes]\ncrun = ["${binDir}/crun"]\n[network]\ndefault_host_ips = [${defaultHostIps}]\n`;
      await mkdir(options.runtimeConfigDir, { recursive: true });
      const configDir = options.runtimeConfigDir.replace(/\/+$/u, "");
      const containersConfigDir = `${configDir}/containers`;
      await mkdir(containersConfigDir, { recursive: true });
      await writeFile(`${configDir}/containers.conf`, body);
      await writeFile(`${configDir}/registries.conf`, MANAGED_REGISTRIES_CONF);
      await writeFile(`${containersConfigDir}/policy.json`, MANAGED_SIGNATURE_POLICY);
    },
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: "lando",
        operation: "setup",
        message: "Failed to write the Lando managed runtime containers.conf.",
        remediation: "Verify the Lando runtime config directory is writable, then rerun `lando setup`.",
        cause,
      }),
  });
