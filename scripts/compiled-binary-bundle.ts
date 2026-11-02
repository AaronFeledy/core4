import type { BunPlugin } from "bun";
import { opentuiNativeCatalog } from "./generated/opentui-native/catalog.generated.ts";

const nativeRootFor = (target: string): string => {
  const root = Object.entries(opentuiNativeCatalog.targetToNativeRoot).find(
    ([candidate]) => candidate === target,
  )?.[1];
  if (root === undefined) throw new Error(`Unknown Lando release target: ${target}.`);
  return root;
};

export const resolveOpenTuiNativeImport = (target: string, path: string): string | undefined => {
  if (!opentuiNativeCatalog.rootImportFilter.test(path)) return undefined;
  const targetNativeRoot = nativeRootFor(target);
  if (targetNativeRoot === path) return undefined;
  return opentuiNativeCatalog.stubPathFor(target, path);
};

export const createOpenTuiPruningPlugin = (target: string): BunPlugin => ({
  name: "opentui-native-pruning",
  setup(build) {
    build.onResolve({ filter: opentuiNativeCatalog.rootImportFilter }, ({ path }) => {
      const resolvedPath = resolveOpenTuiNativeImport(target, path);
      return resolvedPath === undefined ? undefined : { path: resolvedPath };
    });
  },
});

export const compiledBinaryBundleConfig = (
  target: string,
  version: string,
  entrypoints: string[],
): Bun.BuildConfig => ({
  entrypoints,
  target: "bun",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "external",
  define: {
    __LANDO_OPENTUI_NATIVE_ROOT__: JSON.stringify(nativeRootFor(target)),
    __LANDO_CORE_VERSION__: JSON.stringify(version),
  },
  plugins: [createOpenTuiPruningPlugin(target)],
});
