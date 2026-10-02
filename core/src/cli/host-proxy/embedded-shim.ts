import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { resolveUserCacheRoot } from "@lando/engine/cache/paths";
import { makeLandoPaths } from "@lando/paths";
import type { HostProxyContainerTarget } from "@lando/sdk/schema";

export type EmbeddedShimFile = Blob & { readonly name: string };

const digestFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const validCachedShim = async (path: string, digest: string): Promise<boolean> => {
  try {
    return (await digestFile(path)) === digest;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
};

const embeddedAssetFor = (
  files: ReadonlyArray<EmbeddedShimFile>,
  target: HostProxyContainerTarget,
): { readonly asset: EmbeddedShimFile; readonly digest: string } => {
  const prefix = `lando-host-proxy-${target.os}-${target.arch}-`;
  const pattern = new RegExp(`^${prefix}([a-f0-9]{64})\\.bin(?:-[a-z0-9]+)?\\.gz$`);
  const matches = files.flatMap((asset) => {
    const match = pattern.exec(asset.name);
    return match?.[1] === undefined ? [] : [{ asset, digest: match[1] }];
  });
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one embedded host-proxy shim asset for ${target.os}-${target.arch}.`);
  }
  const match = matches[0];
  if (match === undefined) throw new Error("Embedded host-proxy shim asset selection failed.");
  return match;
};

export const extractEmbeddedHostProxyShim = async (input: {
  readonly target: HostProxyContainerTarget;
  readonly embeddedFiles?: ReadonlyArray<EmbeddedShimFile>;
  readonly cacheRoot?: string;
}): Promise<string> => {
  const { asset, digest } = embeddedAssetFor(
    input.embeddedFiles ?? (Bun.embeddedFiles as ReadonlyArray<EmbeddedShimFile>),
    input.target,
  );
  const cacheRoot =
    input.cacheRoot ??
    makeLandoPaths({ userCacheRoot: resolveUserCacheRoot() }).toolDownloadsDir("host-proxy-shim");
  const targetDir = join(cacheRoot, `${input.target.os}-${input.target.arch}`, digest);
  const artifact = join(targetDir, "lando-shim");
  if (await validCachedShim(artifact, digest)) {
    if (process.platform !== "win32") await chmod(artifact, 0o755);
    return artifact;
  }

  const bytes = gunzipSync(new Uint8Array(await asset.arrayBuffer()));
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== digest) throw new Error("Embedded host-proxy shim failed checksum verification.");
  await mkdir(targetDir, { recursive: true });
  const staging = `${artifact}.lando-stage.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(staging, bytes, { flag: "wx", mode: 0o755 });
    if (process.platform !== "win32") await chmod(staging, 0o755);
    try {
      await rename(staging, artifact);
    } catch (cause) {
      if (!(await validCachedShim(artifact, digest))) throw cause;
    }
  } finally {
    await unlink(staging).catch(() => undefined);
  }
  if (!(await validCachedShim(artifact, digest))) {
    throw new Error(`Cached host-proxy shim failed checksum verification: ${artifact}`);
  }
  if (process.platform !== "win32") await chmod(artifact, 0o755);
  return artifact;
};
