import type { BoundaryRule } from "../types.ts";

export const libpodPrefixRule = {
  id: "libpod-prefix",
  scope: {
    roots: ["plugins"],
    extensions: [".ts"],
    excludeDirNames: ["test"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "libpod API prefix check passed.",
  failureHeadline:
    "libpod API prefix check failed. Production provider code must target the Podman 6 libpod API prefix (/v6.0.0), not a Podman 5 prefix (/v5.x.x). Migrate the offending prefixes:",
  onNode: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
