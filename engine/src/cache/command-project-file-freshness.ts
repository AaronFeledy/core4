import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isPathWithin } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import { isMissingFile } from "./command-index-source.ts";
import { MAX_PROJECT_FILE_BYTES, type ProjectFileFingerprint } from "./project-file-fingerprint.ts";

const MAX_CANDIDATES = 256;
const MAX_BYTES = 16 * MAX_PROJECT_FILE_BYTES;
const MAX_DEPTH = 32;

export const commandProjectFilesFresh = async (
  root: string,
  files: readonly ProjectFileFingerprint[],
): Promise<boolean> => {
  if (files.length > MAX_CANDIDATES) return false;
  const seen = new Set<string>();
  const directories = new Set<string>([root]);
  let budget = MAX_BYTES;
  for (const file of files) {
    const { path } = file;
    if (path.length > 4096 || isAbsolute(path)) return false;
    const absolute = resolve(root, path);
    const parts = path.split(sep);
    if (
      path === "" ||
      relative(root, absolute) !== path ||
      !isPathWithin(root, absolute) ||
      parts.length > MAX_DEPTH ||
      seen.has(path)
    )
      return false;
    seen.add(path);
    try {
      let parent = root;
      for (const part of parts.slice(0, -1)) {
        parent = resolve(parent, part);
        if (directories.has(parent)) continue;
        if (!(await lstat(parent)).isDirectory()) return false;
        directories.add(parent);
      }
      const stat = await lstat(absolute).catch((cause: unknown) => {
        if (isMissingFile(cause)) return undefined;
        throw cause;
      });
      if (!file.present) {
        if (stat !== undefined) return false;
        continue;
      }
      const length = file.size + 1;
      if (!stat?.isFile() || stat.size !== file.size || file.size > MAX_PROJECT_FILE_BYTES || length > budget)
        return false;
      budget -= length;
      const flags = constants.O_RDONLY | (sep === "\\" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const handle = await open(absolute, flags);
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.size !== file.size ||
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev
        )
          return false;
        const bytes = new Uint8Array(length);
        let offset = 0;
        while (offset < length) {
          const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset !== file.size || sha256Hex(bytes.subarray(0, offset)) !== file.sha256) return false;
      } finally {
        await handle.close();
      }
    } catch (cause) {
      if (cause instanceof Error) return false;
      throw cause;
    }
  }
  return true;
};
