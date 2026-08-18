import { renderMetaVersion } from "@lando/engine/version";

/**
 * `lando meta:version` — native command metadata adapter for the Effect operation.
 *
 * Bootstrap: `none`. The pure Effect operation lives at
 * `core/src/cli/commands/version.ts` (so `@lando/core/cli` can re-export
 * it without pulling the command registry).
 */
import { type VersionResult, VersionResultSchema, version } from "../../commands/version";
import type { LandoCommandSpec } from "../../spec/command-base";

export const versionSpec: LandoCommandSpec<VersionResult, never> = {
  resultSchema: VersionResultSchema,
  id: "meta:version",
  mcpAllowed: true,
  summary: "Show the Lando + Bun + plugin versions.",
  description: "Show the Lando + Bun + plugin versions.",
  namespace: "meta",
  topLevelAlias: true,
  aliases: ["--version", "-v"],
  hidden: false,
  bootstrap: "none",
  run: () => version,
  render: (result) => {
    if (typeof result !== "object" || result === null || !("core" in result)) return undefined;
    return renderMetaVersion(result as VersionResult);
  },
};
