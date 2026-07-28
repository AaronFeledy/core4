import type { BoundaryRule } from "../types.ts";

export const probeRule = {
  id: "probe",
  scope: {
    roots: ["core/src", "plugins"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: ["core/src/state/lock.ts"], prefixes: [] },
  passMessage: "Probe boundary check passed.",
  failureHeadline:
    "Probe boundary check failed. Host/provider-shaped retry/backoff/timeout-to-verdict probing must build on @lando/sdk/probe (runProbe), not hand-rolled Effect.retry/repeat/schedule or Schedule loops.",
  onProgram: () => {
    // TODO(port)
  },
} satisfies BoundaryRule;
