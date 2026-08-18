/**
 */
import { Effect } from "effect";

import { EmptyResultSchema, type LandoCommandSpec } from "../../../spec/command-base";

export const metaEventsFollowSpec: LandoCommandSpec<never> = {
  resultSchema: EmptyResultSchema,
  id: "meta:events:follow",
  summary: "Follow the lifecycle event trace stream for diagnostics and e2e tests.",
  description: "Follow the lifecycle event trace stream for diagnostics and e2e tests.",
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
