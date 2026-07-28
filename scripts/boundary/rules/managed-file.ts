import type { BoundaryRule } from "../types.ts";

export const managedFileRule = {
  id: "managed-file",
  scope: {
    roots: ["core/src", "plugins"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: ["core/src/managed-file/"] },
  passMessage: "Managed-file boundary check passed.",
  failureHeadline:
    "Managed-file boundary check failed. Host project-file ownership-marker/overwrite logic must route through ManagedFileService (core/src/managed-file/).",
  onNode: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
