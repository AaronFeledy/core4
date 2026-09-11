import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RecipeFile } from "@lando/sdk/schema";

/**
 * Supplies the bytes for one manifest file entry.
 *
 * A bundled recipe carries its auxiliary assets in memory, so its manifest
 * `src` is a label rather than a path on disk. A source returns `undefined` for
 * an entry it does not own, which falls back to reading `src` from `sourceRoot`.
 */
export type RecipeAuxiliaryContentSource = (file: RecipeFile) => Promise<string | undefined>;

/**
 * Renders a `template: true` auxiliary asset.
 *
 * Auxiliary scaffolds interpolate exactly one value site, the app name, and
 * they are user-owned files rather than Landofiles: an app named `${PORT}` must
 * not turn a shell snippet in a scaffold into a substitution. So this stays a
 * literal token replacement rather than an expression evaluation.
 */
export const renderAuxiliaryScaffold = (content: string, appName: string): string =>
  content.replaceAll("{{ app.name }}", appName);

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

/**
 * Resolves the exact bytes an auxiliary entry should write, rendered when the
 * entry declares itself a template.
 */
export const readAuxiliaryScaffoldContent = async (options: {
  readonly file: RecipeFile;
  readonly appName: string;
  readonly contentSource?: RecipeAuxiliaryContentSource | undefined;
  readonly sourceRoot?: string | undefined;
}): Promise<string> => {
  if (
    options.file.when !== undefined ||
    options.file.mode !== undefined ||
    options.file.engine !== undefined
  ) {
    throw new RangeError("Auxiliary when, mode, and engine fields are not supported by recipe init.");
  }
  const supplied = await options.contentSource?.(options.file);
  let content = supplied;
  if (content === undefined) {
    if (options.sourceRoot === undefined) {
      throw new RangeError("Auxiliary source requires a recipe root or content source.");
    }
    const declaredRoot = resolve(options.sourceRoot);
    const source = resolve(declaredRoot, options.file.src);
    const lexicalLocal = relative(declaredRoot, source);
    if (isAbsolute(lexicalLocal) || lexicalLocal === ".." || lexicalLocal.startsWith(`..${sep}`)) {
      throw new RangeError("Auxiliary source must be inside the recipe root.");
    }
    let lexicalCurrent = declaredRoot;
    for (const segment of lexicalLocal.split(sep).filter(Boolean)) {
      lexicalCurrent = resolve(lexicalCurrent, segment);
      if ((await lstat(lexicalCurrent)).isSymbolicLink()) {
        throw new RangeError("Unsafe auxiliary source symlink.");
      }
    }
    const root = await realpath(declaredRoot);
    const canonicalSource = await realpath(source);
    const canonicalLocal = relative(root, canonicalSource);
    if (isAbsolute(canonicalLocal) || canonicalLocal === ".." || canonicalLocal.startsWith(`..${sep}`)) {
      throw new RangeError("Auxiliary source must be inside the recipe root.");
    }
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      content = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  }
  return options.file.template === true ? renderAuxiliaryScaffold(content, options.appName) : content;
};

export const writeAuxiliaryScaffold = async (options: {
  readonly appRoot: string;
  readonly file: RecipeFile;
  readonly appName: string;
  readonly containsSecret: (value: unknown) => boolean;
  readonly contentSource?: RecipeAuxiliaryContentSource | undefined;
  readonly sourceRoot?: string | undefined;
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
  const content = await readAuxiliaryScaffoldContent(options);
  if (options.containsSecret(content)) throw new RangeError("Auxiliary content contains a secret.");
  await Bun.write(path, content);
  return path;
};
