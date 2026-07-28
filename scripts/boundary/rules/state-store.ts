import type { BoundaryRule } from "../types.ts";

export const stateStoreRule = {
  id: "state-store",
  scope: {
    roots: ["core/src", "plugins"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: {
    files: [
      "core/src/cache/atomic.ts",
      "core/src/landofile/includes.ts",
      "core/src/scratch-app/registry.ts",
      "core/src/state-store/atomic.ts",
    ],
    prefixes: ["core/src/state/"],
  },
  passMessage: "State-store boundary check passed.",
  failureHeadline:
    "State-store boundary check failed. Durable atomic-write + lockfile + version-envelope logic must route through core/src/state/.",
  onProgram: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
