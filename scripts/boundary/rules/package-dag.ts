import type { BoundaryRule } from "../types.ts";

export const packageDagRule = {
  id: "package-dag",
  scope: {
    roots: ["plugins/*/src", "core/src"],
    extensions: [".ts"],
    excludePathSegments: ["test"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: ["core/src/plugins/generated/"] },
  passMessage: "Package DAG check passed.",
  failureHeadline: "Package DAG check failed. Fix package dependency direction:",
  onProgram: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
