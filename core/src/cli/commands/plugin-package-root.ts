import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { PluginManifestError, isErrnoCode } from "@lando/sdk/errors";
import { Effect } from "effect";

const parsePackageJson = async (
  packagePath: string,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  const raw = await readFile(packagePath, "utf8");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Readonly<Record<string, unknown>>;
  } catch (cause) {
    if (cause instanceof SyntaxError) return undefined;
    throw cause;
  }
};

const looksLikePluginPackage = (pkg: Readonly<Record<string, unknown>>): boolean => {
  if ("landoPlugin" in pkg) return true;
  if (pkg.api === 4 && typeof pkg.name === "string") return true;
  const keywords = pkg.keywords;
  return Array.isArray(keywords) && keywords.some((entry) => entry === "lando-plugin");
};

export const findNearestPluginPackageRoot = async (cwd: string, commandId: string): Promise<string> => {
  let current = resolve(cwd);
  while (true) {
    const packagePath = join(current, "package.json");
    const packageStat = await stat(packagePath).catch((cause: unknown) => {
      if (isErrnoCode(cause, "ENOENT")) return undefined;
      throw cause;
    });
    if (packageStat?.isFile() === true) {
      const pkg = await parsePackageJson(packagePath);
      if (pkg !== undefined && looksLikePluginPackage(pkg)) return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new PluginManifestError({
        message: `No plugin package.json found from ${resolve(cwd)}.`,
        issues: [`Run ${commandId} from inside a Lando plugin package.`],
      });
    }
    current = parent;
  }
};

export const resolvePluginPackageRoot = Effect.fnUntraced(function* (
  cwd: string | undefined,
  commandId: string,
) {
  const directory = cwd ?? process.cwd();
  return yield* Effect.tryPromise({
    try: () => findNearestPluginPackageRoot(directory, commandId),
    catch: (cause) =>
      cause instanceof PluginManifestError
        ? cause
        : new PluginManifestError({
            message: `Unable to locate plugin root from ${resolve(directory)}.`,
            issues: [String(cause)],
          }),
  });
});
