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

const containersConfBody = (runtimeBinDir: string): string =>
  `[engine]\nhelper_binaries_dir = ["${escapeTomlString(runtimeBinDir)}"]\n`;

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
