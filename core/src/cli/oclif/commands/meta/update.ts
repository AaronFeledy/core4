import { Flags } from "@oclif/core";

import {
  type UpdateOptions,
  type UpdateResult,
  UpdateResultSchema,
  update,
} from "../../../commands/update.ts";
/**
 * `lando meta:update` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const updateOptionsFromInput = (input: unknown): UpdateOptions => {
  const flags =
    typeof input === "object" && input !== null
      ? ((input as { readonly flags?: Record<string, unknown> }).flags ?? {})
      : {};
  const channel = flags.channel;
  return {
    ...(channel === "stable" || channel === "next" || channel === "dev" ? { channel } : {}),
    dryRun: flags["dry-run"] === true,
  };
};

export const updateSpec: LandoCommandSpec<UpdateResult> = {
  resultSchema: UpdateResultSchema,
  id: "meta:update",
  summary: "Update Lando core and plugins.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "plugins",
  run: (input) => update(updateOptionsFromInput(input)),
};

export default class UpdateCommand extends LandoCommandBase {
  static override description = updateSpec.summary;
  static override aliases = [...resolveTopLevelAliases(updateSpec)];
  static override flags = {
    channel: Flags.string({
      description: "Release channel to resolve.",
      options: ["stable", "next", "dev"],
    }),
    "dry-run": Flags.boolean({
      description: "Verify update metadata without replacing the binary.",
      default: false,
    }),
  };
  static override landoSpec: LandoCommandSpec = updateSpec;
  static override bootstrap = updateSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(updateSpec);
  }
}
