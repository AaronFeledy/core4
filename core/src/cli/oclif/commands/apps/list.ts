import { type ListServicesResult, listServices } from "../../../commands/list.ts";
/**
 * SPEC: §8.2 canonical id `apps:list`.
 * `lando apps:list` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const listSpec: LandoCommandSpec<ListServicesResult> = {
  id: "apps:list",
  summary: "List Lando services across apps.",
  namespace: "apps",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: () => listServices(),
};

export default class ListCommand extends LandoCommandBase {
  static override description = listSpec.summary;
  static override aliases = [...resolveTopLevelAliases(listSpec)];
  static override landoSpec: LandoCommandSpec = listSpec;

  override async run(): Promise<void> {
    await this.runEffect(listSpec);
  }
}
