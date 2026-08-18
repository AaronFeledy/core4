import { Flags } from "../../spec/metadata";

import {
  type UpdateOptions,
  type UpdateResult,
  UpdateResultSchema,
  update,
} from "@lando/engine/operations/update";
import type { LandoCommandSpec } from "../../spec/command-base";

export const updateOptionsFromInput = (input: unknown): UpdateOptions => {
  const flags =
    typeof input === "object" && input !== null
      ? ((input as { readonly flags?: Record<string, unknown> }).flags ?? {})
      : {};
  const channel = flags.channel;
  return {
    ...(channel === "stable" || channel === "next" || channel === "dev" ? { channel } : {}),
    dryRun: flags["dry-run"] === true,
    // The CLI shell owns process-entry facts; the engine operation must not
    // read process.argv itself (engine-closure), so supply the re-exec argv here.
    selfUpdate: { argv: process.argv },
  };
};

export const updateSpec: LandoCommandSpec<UpdateResult> = {
  resultSchema: UpdateResultSchema,
  id: "meta:update",
  summary: "Update Lando core and plugins.",
  description: "Update Lando core and plugins.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "plugins",
  flags: {
    channel: Flags.string({
      description: "Release channel to resolve.",
      options: ["stable", "next", "dev"],
    }),
    "dry-run": Flags.boolean({
      description: "Verify update metadata without replacing the binary.",
      default: false,
    }),
  },
  run: (input) => update(updateOptionsFromInput(input)),
};
