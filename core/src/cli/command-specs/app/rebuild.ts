import { Effect } from "effect";

import { type RebuildAppResult, RebuildAppResultSchema, rebuildApp } from "@lando/engine/operations/rebuild";
import { refreshAppCache } from "../../commands/app-cache-refresh";
import { renderRebuildAppResult } from "../../commands/rebuild";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";

import { StreamFrame } from "@lando/sdk/schema";

export const rebuildSpec: LandoCommandSpec<RebuildAppResult> = {
  resultSchema: RebuildAppResultSchema,
  id: "app:rebuild",
  summary: "Rebuild artifacts and restart the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  streaming: StreamFrame,
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return Effect.zipRight(refreshAppCache(), rebuildApp(signal === undefined ? {} : { signal }));
  },
  render: (result) => renderRebuildAppResult(result as RebuildAppResult),
};
