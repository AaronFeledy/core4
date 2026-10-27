import { dirname, join, resolve } from "node:path";
import { isPathWithin, makeLandoPaths } from "@lando/paths";

export const LANDOFILE_BASENAMES = [
  ".lando.base",
  ".lando.dist",
  ".lando.upstream",
  ".lando",
  ".lando.local",
  ".lando.user",
] as const;
export const DISCOVERY_PARENT_BOUND = 64;

export type DiscoveryResult =
  | { readonly kind: "found"; readonly cwd: string; readonly directory: string }
  | {
      readonly kind: "stopped";
      readonly cwd: string;
      readonly directory: string;
      readonly reason: "marker" | "bound" | "root" | "excluded";
    };

export interface TraversalAccess {
  readonly exists: (path: string) => Promise<boolean>;
  readonly excluded: (directory: string) => boolean;
}

/** Check the starting directory plus at most 64 parents. Presence wins over a stop marker. */
export const walkAppDirectories = async (cwd: string, access: TraversalAccess): Promise<DiscoveryResult> => {
  let directory = resolve(cwd);
  for (let parents = 0; ; parents++) {
    if (access.excluded(directory)) return { kind: "stopped", cwd, directory, reason: "excluded" };
    const present = await Promise.all(
      LANDOFILE_BASENAMES.flatMap((basename) =>
        ["yml", "ts"].map((extension) => access.exists(join(directory, `${basename}.${extension}`))),
      ),
    );
    if (present.some(Boolean)) return { kind: "found", cwd, directory };
    if (await access.exists(join(directory, ".lando.stop")))
      return { kind: "stopped", cwd, directory, reason: "marker" };
    const parent = dirname(directory);
    if (parent === directory) return { kind: "stopped", cwd, directory, reason: "root" };
    if (parents === DISCOVERY_PARENT_BOUND) return { kind: "stopped", cwd, directory, reason: "bound" };
    directory = parent;
  }
};

export interface AppDiscoveryResolver {
  readonly resolve: (cwd: string) => Promise<DiscoveryResult>;
}

/** The caller owns this memo and must discard it at the end of the operation. */
export const makeAppDiscoveryResolver = (
  access?: TraversalAccess,
  walk = walkAppDirectories,
): AppDiscoveryResolver => {
  let paths: ReturnType<typeof makeLandoPaths> | undefined;
  const filesystem = access ?? {
    exists: (path: string) => Bun.file(path).exists(),
    excluded: (directory: string) => {
      paths ??= makeLandoPaths();
      return directory === paths.globalAppRoot || isPathWithin(paths.scratchDir, directory);
    },
  };
  const results = new Map<string, Promise<DiscoveryResult>>();
  return {
    resolve: (cwd) => {
      const key = resolve(cwd);
      const previous = results.get(key);
      if (previous !== undefined) return previous;
      const result = walk(key, filesystem).then((found) => {
        if (found.kind === "found" && !results.has(found.directory))
          results.set(found.directory, Promise.resolve({ ...found, cwd: found.directory }));
        return found;
      });
      results.set(key, result);
      return result;
    },
  };
};
