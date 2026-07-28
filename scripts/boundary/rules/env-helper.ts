import type { BoundaryRule } from "../types.ts";

export const envHelperRule = {
  id: "env-helper",
  scope: {
    roots: ["plugins/service-lando/src/services"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Env helper boundary check passed.",
  failureHeadline:
    "Env helper boundary check failed. Service files must not import lando.env helpers directly.",
  onEdges: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
