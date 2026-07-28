import type { BoundaryRule } from "../types.ts";

export const generatedOutputRule = {
  id: "generated-output",
  scope: {
    roots: ["core/src", "sdk/src", "plugins/*/src"],
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Generated output boundary check passed.",
  failureHeadline: "Generated output boundary check failed.",
  onProgram: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
