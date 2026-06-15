import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { PluginManifestError } from "@lando/sdk/errors";

const isMissingPathError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const parsePackageJson = async (
  packagePath: string,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  const raw = await readFile(packagePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Readonly<Record<string, unknown>>;
};

const looksLikePluginPackage = (pkg: Readonly<Record<string, unknown>>): boolean => {
  if ("landoPlugin" in pkg) return true;
  if (pkg.api === 4 && typeof pkg.name === "string") return true;
  const keywords = pkg.keywords;
  return Array.isArray(keywords) && keywords.some((entry) => entry === "lando-plugin");
};

export const findNearestPluginPackageRoot = async (
  cwd: string,
  commandId: "meta:plugin:build" | "meta:plugin:test",
): Promise<string> => {
  let current = resolve(cwd);
  while (true) {
    const packagePath = join(current, "package.json");
    const packageStat = await stat(packagePath).catch((cause: unknown) => {
      if (isMissingPathError(cause)) return undefined;
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
