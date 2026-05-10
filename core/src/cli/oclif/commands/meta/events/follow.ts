/**
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const metaEventsFollowSpec: LandoCommandSpec<never> = {
  id: "meta:events:follow",
  summary: "Follow the lifecycle event trace stream for diagnostics and e2e tests.",
  namespace: "meta",
  topLevelAlias: "events",
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:events:follow"),
};

export default class MetaEventsFollowCommand extends LandoCommandBase {
  static override description = metaEventsFollowSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaEventsFollowSpec)];
  static override landoSpec: LandoCommandSpec = metaEventsFollowSpec;

  override async run(): Promise<void> {
    await this.runEffect(metaEventsFollowSpec);
  }
}
