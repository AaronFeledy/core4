import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
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
  )
    throw new RangeError("Auxiliary destination must be inside the app root.");
  return path;
};

/**
 * Supplies the bytes for one manifest file entry.
 *
 * A bundled recipe carries its auxiliary assets in memory, so its manifest
 * `src` is a label rather than a path on disk. A source returns `undefined` for
 * an entry it does not own, which falls back to reading `src` from `sourceRoot`.
 */
export type RecipeAuxiliaryContentSource = (file: RecipeFile) => Promise<string | Uint8Array | undefined>;

type RecipeAuxiliarySourceOpener = (path: string, flags: number) => Promise<FileHandle>;

/**
 * Renders a `template: true` auxiliary asset.
 *
 * Auxiliary scaffolds interpolate exactly one value site, the app name, and
 * they are user-owned files rather than Landofiles: an app named `${PORT}` must
 * not turn a shell snippet in a scaffold into a substitution. So this stays a
 * literal token replacement rather than an expression evaluation.
 */
export const renderAuxiliaryScaffold = (content: string | Uint8Array, appName: string): string => {
  const text =
    typeof content === "string"
      ? content
      : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  return text.replaceAll("{{ app.name }}", () => appName);
};

/**
 * Resolves the exact bytes an auxiliary entry should write, rendered when the
 * entry declares itself a template.
 */
export const readAuxiliaryScaffoldContent = async (options: {
  readonly file: RecipeFile;
  readonly appName: string;
  readonly contentSource?: RecipeAuxiliaryContentSource | undefined;
  readonly openSource?: RecipeAuxiliarySourceOpener | undefined;
  readonly sourceRoot?: string | undefined;
}): Promise<string | Uint8Array> => {
  if (options.file.when !== undefined || options.file.engine !== undefined) {
    throw new RangeError("Auxiliary when and engine fields are not supported by recipe init.");
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
    const canonicalParent = dirname(canonicalSource);
    const canonicalLocal = relative(root, canonicalSource);
    if (isAbsolute(canonicalLocal) || canonicalLocal === ".." || canonicalLocal.startsWith(`..${sep}`)) {
      throw new RangeError("Auxiliary source must be inside the recipe root.");
    }
    const validatedParent = await lstat(canonicalParent);
    const validatedSource = await lstat(canonicalSource);
    const openSource: RecipeAuxiliarySourceOpener = options.openSource ?? open;
    const handle = await openSource(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedSource = await handle.stat();
      const currentCanonicalSource = await realpath(source);
      const currentCanonicalParent = await realpath(dirname(source));
      const currentCanonicalLocal = relative(root, currentCanonicalSource);
      const currentParent = await lstat(currentCanonicalParent);
      const currentSource = await lstat(currentCanonicalSource);
      if (
        isAbsolute(currentCanonicalLocal) ||
        currentCanonicalLocal === ".." ||
        currentCanonicalLocal.startsWith(`..${sep}`) ||
        currentCanonicalSource !== canonicalSource ||
        currentCanonicalParent !== canonicalParent ||
        currentParent.dev !== validatedParent.dev ||
        currentParent.ino !== validatedParent.ino ||
        currentSource.dev !== validatedSource.dev ||
        currentSource.ino !== validatedSource.ino ||
        openedSource.dev !== validatedSource.dev ||
        openedSource.ino !== validatedSource.ino
      ) {
        throw new RangeError("Auxiliary source changed during open.");
      }
      content = await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  if (options.file.template !== true) return content;
  return renderAuxiliaryScaffold(content, options.appName);
};
