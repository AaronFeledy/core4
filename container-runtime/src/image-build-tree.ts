import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createSourceTreeDigest } from "@lando/sdk/digest";
import type { ArtifactBuildContextTree } from "@lando/sdk/services";
import type { BuildContextEntry } from "./build-context.ts";

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export const treeArchivePath = (contextName: string) => `.lando-trees/${contextName}/`;

export const packVerifiedBuildTrees = async (trees: readonly ArtifactBuildContextTree[]) => {
  const entries: BuildContextEntry[] = [];
  let remaining = MAX_BYTES;
  for (const tree of trees) {
    const prefix = treeArchivePath(tree.contextName);
    const { root } = tree;
    if (!isAbsolute(root) || (await realpath(root)) !== root || !(await lstat(root)).isDirectory()) {
      throw new TypeError("Invalid verified build context root.");
    }
    const digest = createSourceTreeDigest();
    const walk = async (directory: string, parent: string): Promise<void> => {
      if ((await realpath(directory)) !== directory) throw new TypeError("Linked build context directory.");
      const names: string[] = [];
      for await (const entry of await opendir(directory)) {
        names.push(entry.name);
        if (names.length + entries.length >= MAX_ENTRIES)
          throw new RangeError("Build context entry limit exceeded.");
      }
      for (const name of names.sort()) {
        const relative = parent + name;
        const archived = prefix + relative;
        if (
          !/^[a-z0-9._@+ -]+$/iu.test(name) ||
          name === "." ||
          name === ".." ||
          Buffer.byteLength(archived) > 240 ||
          Buffer.byteLength(name) > 99 ||
          entries.length >= MAX_ENTRIES
        ) {
          throw new TypeError("Invalid or oversized build context entry.");
        }
        const path = join(directory, name);
        const stat = await lstat(path);
        if (stat.isDirectory()) {
          digest.entry(relative, "dir", false, new Uint8Array());
          entries.push({ kind: "directory", name: `${archived}/`, mode: 0o755 });
          await walk(path, `${relative}/`);
          continue;
        }
        if (!stat.isFile() || (await realpath(path)) !== path)
          throw new TypeError("Build context must contain only regular files and directories.");
        await using handle = await open(path, OPEN_FLAGS);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > remaining)
          throw new RangeError("Build context byte limit exceeded.");
        const content = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < content.length) {
          const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
          if (bytesRead === 0) throw new TypeError("Build context file changed while reading.");
          offset += bytesRead;
        }
        const executable = (opened.mode & 0o111) !== 0;
        remaining -= content.length;
        digest.entry(relative, "file", executable, content);
        entries.push({ kind: "file", name: archived, mode: executable ? 0o755 : 0o644, content });
      }
    };
    entries.push({ kind: "directory", name: prefix, mode: 0o755 });
    await walk(root, "");
    if (digest.hex() !== tree.digest)
      throw new TypeError(`Build context digest mismatch for ${tree.contextName}.`);
  }
  return entries;
};
