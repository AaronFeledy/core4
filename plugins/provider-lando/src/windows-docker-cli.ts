import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";

const failure = (message: string, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "prepareFileSyncTransport",
    message,
    remediation: "Run `lando setup` to restore the managed runtime before retrying file sync.",
    ...(cause === undefined ? {} : { cause }),
  });

const regularFile = async (file: string): Promise<boolean> => {
  const info = await lstat(file);
  return info.isFile() && !info.isSymbolicLink() && info.size > 0;
};

const realDirectory = async (directory: string): Promise<boolean> => {
  const info = await lstat(directory);
  return info.isDirectory() && !info.isSymbolicLink();
};

/**
 * Mutagen's docker transport launches docker.exe from MUTAGEN_DOCKER_PATH.
 * Keep the Podman alias in a provider-owned subdirectory so that only the
 * Mutagen child receives it; no host PATH or Docker installation is changed.
 * The caller must supply the managed runtime bin directory after setup.
 */
export const prepareWindowsDockerCli = (
  runtimeBinDir: string,
  platform: HostPlatform = process.platform as HostPlatform,
  options: { readonly repairExisting?: boolean } = {},
): Effect.Effect<string, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      if (hostPlatformFamily(platform) !== "win32" || !isAbsolute(runtimeBinDir)) {
        throw new Error("A managed absolute Windows runtime directory is required.");
      }
      if (!(await realDirectory(runtimeBinDir))) {
        throw new Error("The managed runtime directory is missing or redirected.");
      }
      const marker = join(runtimeBinDir, ".runtime-installed-version");
      if (!(await regularFile(marker)) || (await readFile(marker, "utf8")).trim().length === 0) {
        throw new Error("The managed runtime installation marker is missing.");
      }
      const podman = join(runtimeBinDir, "podman.exe");
      if (!(await regularFile(podman))) {
        throw new Error("The managed Podman executable is missing or redirected.");
      }
      const original = await readFile(podman);
      const compatibilityDir = join(runtimeBinDir, "docker-compat");
      await mkdir(compatibilityDir, { recursive: true });
      if (!(await realDirectory(compatibilityDir))) {
        throw new Error("The Docker-compatible CLI directory is redirected.");
      }
      const docker = join(compatibilityDir, "docker.exe");
      let present = false;
      try {
        const info = await lstat(docker);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error("The Docker-compatible CLI is redirected or is not a regular file.");
        }
        present = true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      const matches = present && (await readFile(docker)).equals(original);
      if (present && !matches && options.repairExisting !== true) {
        throw new Error("The Docker-compatible CLI does not match managed Podman.");
      }
      if (!matches) {
        const staged = join(compatibilityDir, `.docker.exe.${randomUUID()}`);
        try {
          await copyFile(podman, staged, constants.COPYFILE_EXCL);
          if (!(await regularFile(staged)) || !(await readFile(staged)).equals(original)) {
            throw new Error("The staged Docker-compatible CLI differs from managed Podman.");
          }
          if (present) {
            // Setup owns this regular file. Rename replaces its directory entry
            // without ever executing or modifying the corrupt bytes.
            await rename(staged, docker);
          } else {
            try {
              await link(staged, docker);
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
            }
          }
        } finally {
          await rm(staged, { force: true });
        }
      }
      if (
        !(await regularFile(docker)) ||
        !(await readFile(docker)).equals(original) ||
        !(await regularFile(podman)) ||
        !(await readFile(podman)).equals(original)
      ) {
        throw new Error("The Docker-compatible CLI does not match managed Podman.");
      }
      return docker;
    },
    catch: (cause) =>
      failure("Could not prepare a verified Docker-compatible CLI from managed Podman.", cause),
  });
