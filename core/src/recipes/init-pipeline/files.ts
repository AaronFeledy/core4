import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RecipeFile } from "@lando/sdk/schema";

export const auxiliaryDestination = (root: string, destination: string): string => {
  const path = resolve(root, destination);
  const local = relative(root, path);
  if (
    isAbsolute(destination) ||
    isAbsolute(local) ||
    local === "" ||
    local === ".." ||
    local.startsWith(`..${sep}`)
  ) {
    throw new RangeError("Auxiliary destination must be inside the app root.");
  }
  return path;
};

export const writeAuxiliaryScaffold = async (options: {
  readonly appRoot: string;
  readonly file: RecipeFile;
  readonly containsSecret: (value: unknown) => boolean;
  readonly write?: (path: string, content: string) => Promise<void>;
}): Promise<string | undefined> => {
  const path = auxiliaryDestination(options.appRoot, options.file.dest);
  // Never follow an auxiliary parent symlink, including one pointing inside the app.
  const root = await realpath(options.appRoot);
  let current = root;
  for (const segment of relative(options.appRoot, dirname(path)).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RangeError("Unsafe auxiliary parent.");
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT")
        throw error;
      await mkdir(current);
    }
  }
  try {
    await lstat(path);
    return undefined;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT")
      throw error;
  }
  // The request has no source-root port, so a relative src would resolve against
  // the process working directory. Require the caller to resolve it instead.
  if (!isAbsolute(options.file.src)) {
    throw new RangeError("Auxiliary source must be an absolute path resolved by the caller.");
  }
  const content = await Bun.file(options.file.src).text();
  if (options.containsSecret(content)) throw new RangeError("Auxiliary content contains a secret.");
  if (options.write === undefined) await Bun.write(path, content);
  else await options.write(path, content);
  return path;
};
