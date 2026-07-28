import type { BoundaryRule } from "../types.ts";

export const networkRule = {
  id: "network",
  scope: {
    roots: ["core/src", "plugins"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: ["core/src/http-client/live.ts"], prefixes: [] },
  passMessage: "Network boundary check passed.",
  failureHeadline:
    "Network boundary check failed. Lando-owned outbound HTTP must route through the HttpClient adapter (@lando/core HttpClient), not direct global fetch. Carve-outs are limited to BunSelfRunner package-manager ops and the standalone installer scripts.",
  onNode: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
