import type { BoundaryRule } from "../types.ts";

export const importCycleRule = {
  id: "import-cycle",
  scope: {
    roots: ["core/src", "sdk/src", "container-runtime/src", "plugins/*/src"],
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Import cycle check passed.",
  failureHeadline: "Import cycle check failed. Break each runtime dependency cycle:",
  onProgram: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
