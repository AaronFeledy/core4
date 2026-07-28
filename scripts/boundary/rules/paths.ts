import type { BoundaryRule } from "../types.ts";

export const pathsRule = {
  id: "paths",
  scope: {
    roots: ["core/src", "plugins"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: ["core/src/config/paths.ts"], prefixes: [] },
  passMessage: "Paths boundary check passed.",
  failureHeadline:
    "Paths boundary check failed. Hand-rolled root joins must use @lando/core/paths (makeLandoPaths) or PathsService.",
  onNode: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
