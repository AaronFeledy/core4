import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { importAuthorModule } from "@lando/landofile/author-modules";
import { isPathWithin } from "@lando/paths";

import { type PluginImplementation, pluginImplementationIdentity } from "./implementation-identity.ts";

type Drain = (previous: PluginImplementation) => Promise<void>;
const drains = new Set<Drain>();
const imported = new Map<string, PluginImplementation>();
let pending = Promise.resolve();
// createRequire is anchored to an absolute host path, including in compiled executables.
const modules = createRequire(join(process.cwd(), "lando-plugin-cache.cjs")).cache;

export const registerPluginReloadDrain = (drain: Drain): (() => void) => {
  drains.add(drain);
  return () => {
    drains.delete(drain);
  };
};

const evict = async (
  implementation: PluginImplementation,
  dependencies: boolean,
  failed = false,
): Promise<void> => {
  const keys = new Set([...Object.keys(modules), ...implementation.files]);
  if (failed) {
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: implementation.realpath,
      absolute: true,
      dot: true,
      followSymlinks: false,
    }))
      keys.add(file);
  }
  for (const key of keys) {
    // Virtual host peers (effect and @lando/sdk) have bare specifier keys, never disk paths.
    if (!isAbsolute(key)) continue;
    const canonical = await realpath(key).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return key;
      throw cause;
    });
    if (!isPathWithin(implementation.realpath, canonical)) continue;
    if (!dependencies && isPathWithin(join(implementation.realpath, "node_modules"), canonical)) continue;
    delete modules[key];
  }
};

/** Serializes drain, eviction, and import across every runtime in this Bun process. */
export const loadPluginModules = <A>(
  root: string,
  load: () => Promise<A>,
): Promise<{
  readonly value: A;
  readonly implementation: PluginImplementation;
  readonly stable: boolean;
}> => {
  // This queue has no cancellation signal: eviction and import finish even if the requester leaves.
  const operation = pending.then(async () => {
    const current = await pluginImplementationIdentity(root);
    const previous = imported.get(current.realpath);
    if (previous !== undefined && previous.identity !== current.identity) {
      await Promise.all([...drains].map((drain) => drain(previous)));
      await evict(current, previous.dependencies !== current.dependencies);
      imported.delete(current.realpath);
    }
    try {
      const value = await load();
      const after = await pluginImplementationIdentity(current.realpath);
      imported.set(current.realpath, current);
      return { value, implementation: current, stable: current.identity === after.identity };
    } catch (cause) {
      await evict(current, true, true);
      imported.delete(current.realpath);
      throw cause;
    }
  });
  pending = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
};

export const importPluginModule = (path: string): Promise<unknown> =>
  importAuthorModule(pathToFileURL(path).href);
