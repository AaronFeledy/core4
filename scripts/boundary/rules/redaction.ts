import type { BoundaryRule } from "../types.ts";

export const redactionRule = {
  id: "redaction",
  scope: {
    roots: ["core/src", "plugins"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Redaction boundary check passed.",
  failureHeadline:
    "Redaction boundary check failed. Redaction sentinels and ad-hoc secret-matching regexes must route through @lando/sdk/secrets.",
  onNode: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
