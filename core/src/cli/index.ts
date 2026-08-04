/**
 * Programmatic CLI runner. Keep runtime imports dynamic so loading this module
 * does not eagerly pull Effect into embedding hosts. Version and shellenv fast
 * paths stay in the binary entry and return before this module loads.
 */

import type { RunCliOptions } from "./run.ts";

export type { RunCliOptions } from "./run.ts";

export const runCli = async (options: RunCliOptions): Promise<void> => {
  const cli = await import("./run.ts");
  await cli.runCli(options);
};
