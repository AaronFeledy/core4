import { type ListServicesResult, listServices } from "../../commands/list.ts";
/**
 * `lando list` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const listSpec: LandoCommandSpec<ListServicesResult> = {
  id: "list",
  summary: "List Lando services across apps.",
  bootstrap: "provider",
  run: () => listServices(),
};

export default class ListCommand extends LandoCommandBase {
  static override description = listSpec.summary;
  static override landoSpec: LandoCommandSpec = listSpec;

  override async run(): Promise<void> {
    await this.runEffect(listSpec);
  }
}
