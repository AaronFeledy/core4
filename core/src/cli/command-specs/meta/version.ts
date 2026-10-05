import { type VersionResult, VersionResultSchema, version } from "../../commands/version";
import type { LandoCommandSpec } from "../../spec/command-base";

/**
 * `lando meta:version` — native command metadata adapter for the Effect operation.
 *
 * Bootstrap: `none`. The pure Effect operation lives at
 * `core/src/cli/commands/version.ts` (so `@lando/core/cli` can re-export
 * it without pulling the command registry).
 */

export const versionSpec: LandoCommandSpec<VersionResult, never> = {
  resultSchema: VersionResultSchema,
  id: "meta:version",
  mcpAllowed: true,
  summary: "Print the Lando version.",
  description: "Print the Lando version. Machine output also reports the Bun version and platform.",
  namespace: "meta",
  topLevelAlias: true,
  aliases: ["--version", "-v"],
  hidden: false,
  bootstrap: "none",
  run: () => version,
  render: (result) => {
    if (typeof result !== "object" || result === null || !("core" in result)) return undefined;
    return (result as VersionResult).core;
  },
};
