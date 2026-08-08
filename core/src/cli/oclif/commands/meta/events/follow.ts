/**
 */
import { Effect } from "effect";

import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../../command-base";

export const metaEventsFollowSpec: LandoCommandSpec<never> = {
  resultSchema: EmptyResultSchema,
  id: "meta:events:follow",
  summary: "Follow the lifecycle event trace stream for diagnostics and e2e tests.",
  namespace: "meta",
  topLevelAlias: "events",
  bootstrap: "minimal",
  deferred: {
    phase: "4.1",
    summary: "Lifecycle-event streaming through `meta:events:follow` is not available yet.",
    remediation:
      "`meta:events:follow` is not available yet. Use `--renderer=json` on a specific command to observe its event stream.",
  },
  run: () => Effect.die("not yet implemented: meta:events:follow"),
};

export default class MetaEventsFollowCommand extends LandoCommandBase {
  static override description = metaEventsFollowSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaEventsFollowSpec)];
  static override landoSpec: LandoCommandSpec = metaEventsFollowSpec;
  static override bootstrap = metaEventsFollowSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaEventsFollowSpec);
  }
}
