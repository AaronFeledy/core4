import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isPathWithin } from "@lando/paths";
import { SourceAcquisitionError } from "./errors.ts";

export const containedPath = (root: string, ...parts: readonly string[]): string => {
  const target = resolve(root, ...parts);
  if (!isPathWithin(root, target))
    throw new SourceAcquisitionError({
      message: "Source path escapes the store root.",
      source: "cache",
      kind: "cache",
      remediation: "Use a contained source store path.",
    });
  return target;
};

export const realContainedPath = async (root: string, path: string): Promise<string> => {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  containedPath(canonicalRoot, canonical);
  return canonical;
};

export const treeDigest = async (root: string): Promise<string> => {
  const digest = createHash("sha256");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const path = containedPath(root, rel);
      const stat = await lstat(path);
      const type = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file";
      const bytes = stat.isSymbolicLink()
        ? Buffer.from(await readlink(path))
        : stat.isDirectory()
          ? Buffer.alloc(0)
          : await readFile(path);
      digest.update(JSON.stringify([rel, type, stat.isFile() && (stat.mode & 0o111) !== 0, bytes.length]));
      digest.update("\0");
      digest.update(bytes);
      if (stat.isDirectory()) await walk(path, rel);
    }
  };
  await walk(root, "");
  return digest.digest("hex");
};
