import type { BoundaryRule } from "../types.ts";

export const rendererRule = {
  id: "renderer",
  scope: {
    roots: ["core/src", "plugins"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: {
    files: ["core/bin/lando.ts", "core/src/cli/oclif/pre-renderer.ts", "core/src/interaction/service.ts"],
    prefixes: [],
  },
  passMessage: "Renderer boundary check passed.",
  failureHeadline:
    "Renderer boundary check failed. Direct console/process writes must route through the Renderer boundary.",
  onNode: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
