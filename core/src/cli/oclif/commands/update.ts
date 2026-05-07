import { type UpdateResult, update } from "../../commands/update.ts";
/**
 * `lando update` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const updateSpec: LandoCommandSpec<UpdateResult> = {
  id: "update",
  summary: "Update Lando core and plugins.",
  bootstrap: "plugins",
  run: () => update(),
};

export default class UpdateCommand extends LandoCommandBase {
  static override description = updateSpec.summary;
  static override landoSpec: LandoCommandSpec = updateSpec;

  override async run(): Promise<void> {
    await this.runEffect(updateSpec);
  }
}
