import type { BoundaryRule } from "../types.ts";

export const machineOutputRule = {
  id: "machine-output",
  scope: {
    roots: ["core/src", "plugins"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: ["core/src/cli/result-encode.ts"], prefixes: [] },
  passMessage: "Machine output boundary check passed.",
  failureHeadline:
    "Machine output boundary check failed. Command-result envelopes must serialize only through encodeCommandResult, and every command spec must declare a resultSchema.",
  onNode: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
