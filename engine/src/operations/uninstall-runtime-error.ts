import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

export const UNINSTALL_RUNTIME_DIR_LEFTOVER_MESSAGE = "Failed to remove runtime directory leftover";

export class UninstallRuntimeDirError extends Schema.TaggedError<UninstallRuntimeDirError>()(
  "UninstallRuntimeDirError",
  {
    message: Schema.String,
    path: Schema.String,
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const uninstallRuntimeDirRemediation = (
  path: string,
  managedPodmanExists: boolean,
  managedPodman: string,
): string =>
  managedPodmanExists
    ? `Run \`${managedPodman} unshare rm -rf ${path}\` then rerun \`lando uninstall --purge --yes\`.`
    : `Run \`sudo rm -rf ${path}\` then rerun \`lando uninstall --purge --yes\`.`;

export const formatUninstallRuntimeDirStepError = (error: UninstallRuntimeDirError): string =>
  `${error.message} (${error.path}). ${error.remediation}`;

export const preferLeftoverRuntimePath = (runtimeDir: string, exists: (path: string) => boolean): string => {
  const volumesRoot = join(runtimeDir, "storage", "volumes");
  if (!exists(volumesRoot)) return runtimeDir;
  const first = firstExistingPath(volumesRoot, exists);
  return first ?? runtimeDir;
};

const firstExistingPath = (root: string, exists: (path: string) => boolean): string | undefined => {
  if (!exists(root)) return undefined;
  let names: string[];
  try {
    names = readdirSync(root).toSorted((a, b) => a.localeCompare(b));
  } catch {
    return root;
  }
  for (const name of names) {
    const child = join(root, name);
    const nested = firstExistingPath(child, exists);
    if (nested !== undefined) return nested;
  }
  return root;
};

export const leftoverUninstallRuntimeDirError = (
  runtimeDir: string,
  exists: (path: string) => boolean,
  cause?: unknown,
): UninstallRuntimeDirError => {
  const leftoverPath = preferLeftoverRuntimePath(runtimeDir, exists);
  const managedPodman = join(runtimeDir, "bin", "podman");
  return new UninstallRuntimeDirError({
    message: UNINSTALL_RUNTIME_DIR_LEFTOVER_MESSAGE,
    path: leftoverPath,
    remediation: uninstallRuntimeDirRemediation(leftoverPath, exists(managedPodman), managedPodman),
    ...(cause === undefined ? {} : { cause }),
  });
};
