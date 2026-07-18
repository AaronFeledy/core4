import { Flags } from "@oclif/core";
import { Effect } from "effect";

import {
  DefaultGlobalListLayer,
  type GlobalListResult,
  GlobalListResultSchema,
  globalList,
  renderGlobalListResult,
} from "../../../../commands/meta/global-list.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const metaGlobalListSpec: LandoCommandSpec<GlobalListResult> = {
  resultSchema: GlobalListResultSchema,
  id: "meta:global:list",
  summary:
    "List every contributed global service, its source plugin, enabled state, and per-service commands.",
  namespace: "meta",
  topLevelAlias: "global:list",
  bootstrap: "minimal",
  run: () => globalList().pipe(Effect.provide(DefaultGlobalListLayer)),
  render: (result, _input, ctx) => renderGlobalListResult(result as GlobalListResult, ctx),
};

export default class MetaGlobalListCommand extends LandoCommandBase {
  static override description = metaGlobalListSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalListSpec)];
  static override flags = {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  };
  static override landoSpec: LandoCommandSpec = metaGlobalListSpec;
  static override bootstrap = metaGlobalListSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalListSpec);
  }
}
