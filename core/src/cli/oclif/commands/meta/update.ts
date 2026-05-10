import { type UpdateResult, update } from "../../../commands/update.ts";
/**
 * `lando meta:update` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const updateSpec: LandoCommandSpec<UpdateResult> = {
  id: "meta:update",
  summary: "Update Lando core and plugins.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "plugins",
  run: () => update(),
};

export default class UpdateCommand extends LandoCommandBase {
  static override description = updateSpec.summary;
  static override aliases = [...resolveTopLevelAliases(updateSpec)];
  static override landoSpec: LandoCommandSpec = updateSpec;

  override async run(): Promise<void> {
    await this.runEffect(updateSpec);
  }
}
