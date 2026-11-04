import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "@lando/sdk/digest";
import { isErrnoCode } from "@lando/sdk/errors";
import { writeFileAtomic } from "@lando/state-store/atomic";
import { Schema } from "effect";

import { DebianArchiveError, verifyStaticCatatonit } from "./catatonit-payload.ts";
import {
  type CatatonitPackage,
  buildCatatonitIdentity,
  catatonitIdentityMatchesPackage,
  decodeCatatonitIdentity,
  managedCatatonitIdentityPath,
  managedCatatonitNoticesDir,
  runtimeInstalledVersionPath,
  serializeCatatonitIdentity,
} from "./catatonit-pins.ts";

export const readInstalledRuntimeVersion = async (runtimeBinDir: string): Promise<string | undefined> => {
  try {
    const content = await readFile(runtimeInstalledVersionPath(runtimeBinDir), "utf8");
    const version = content.trim();
    return version.length > 0 ? version : undefined;
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
};

export const isUsableManagedCatatonit = async (path: string, pkg: CatatonitPackage): Promise<boolean> => {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o7777) !== 0o755 ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    )
      return false;
    verifyStaticCatatonit(new Uint8Array(await readFile(path)), pkg);
    return true;
  } catch (cause) {
    if (cause instanceof DebianArchiveError || isErrnoCode(cause, "ENOENT")) return false;
    throw cause;
  }
};

/** Verify pinned license text files under licenses/catatonit (packaged or bridge notices). */
export const verifyManagedCatatonitNotices = async (
  runtimeBinDir: string,
  pkg: CatatonitPackage,
  options?: { readonly requireBridgeNoticesMd?: boolean },
): Promise<boolean> => {
  const dir = managedCatatonitNoticesDir(runtimeBinDir);
  try {
    for (const text of pkg.license.texts) {
      const path = join(dir, text.file);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) return false;
      if (sha256Hex(new Uint8Array(await readFile(path))) !== text.sha256) return false;
    }
    if (options?.requireBridgeNoticesMd === true) {
      const notices = await readFile(join(dir, "NOTICES.md"), "utf8");
      if (!notices.includes(pkg.license.spdx) || !notices.includes(pkg.license.source)) return false;
    }
    return true;
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return false;
    throw cause;
  }
};

export const verifyManagedCatatonitIdentity = async (
  runtimeBinDir: string,
  pkg: CatatonitPackage,
): Promise<boolean> => {
  try {
    const path = managedCatatonitIdentityPath(runtimeBinDir);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const identity = decodeCatatonitIdentity(JSON.parse(await readFile(path, "utf8")));
    return catatonitIdentityMatchesPackage(identity, pkg);
  } catch (cause) {
    if (cause instanceof SyntaxError || isErrnoCode(cause, "ENOENT") || Schema.isSchemaError(cause))
      return false;
    throw cause;
  }
};

/** mkdir then lstat: owner-controlled real directory, never a symlink hop. */
const ensureOwnerControlledDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  ) {
    throw new DebianArchiveError(
      "Managed catatonit notices directory must be owner-controlled and not symlinked.",
    );
  }
  if ((info.mode & 0o022) !== 0) await chmod(dir, info.mode & 0o755);
};

export const writeBridgeNotices = async (
  runtimeBinDir: string,
  pkg: CatatonitPackage,
  licenseFiles: ReadonlyArray<{ readonly file: string; readonly bytes: Uint8Array }>,
): Promise<void> => {
  // Validate licenses/, then licenses/catatonit/, before any notice write — never through a symlink.
  const licensesDir = join(runtimeBinDir, "licenses");
  const dir = managedCatatonitNoticesDir(runtimeBinDir);
  await ensureOwnerControlledDir(licensesDir);
  await ensureOwnerControlledDir(dir);
  for (const text of licenseFiles) {
    await writeFileAtomic(join(dir, text.file), text.bytes, { mode: 0o644, ownerOnly: "best-effort" });
  }
  const lines = [
    `# catatonit ${pkg.version}`,
    "",
    `SPDX: ${pkg.license.spdx}`,
    "",
    `Source: ${pkg.license.source}`,
    "",
    ...licenseFiles.map((text) => `- licenses/catatonit/${text.file}`),
    "",
  ];
  await writeFileAtomic(join(dir, "NOTICES.md"), `${lines.join("\n")}\n`, {
    mode: 0o644,
    ownerOnly: "best-effort",
  });
};

export const writeBridgeIdentity = async (runtimeBinDir: string, pkg: CatatonitPackage): Promise<void> => {
  await writeFileAtomic(
    managedCatatonitIdentityPath(runtimeBinDir),
    serializeCatatonitIdentity(buildCatatonitIdentity(pkg)),
    { mode: 0o644, ownerOnly: "best-effort" },
  );
};
