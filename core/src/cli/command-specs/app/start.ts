import { Effect } from "effect";

import { startApp } from "@lando/engine/operations/start";
import { withIncompleteStartNotice } from "@lando/engine/operations/start-incomplete-notice";
import { StartAppResult, StreamFrame } from "@lando/sdk/schema";
import { refreshAppCache } from "../../commands/app-cache-refresh";
import { renderStartAppResult } from "../../commands/start-result";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";

/**
 * `lando app:start` — native command metadata adapter.
 */

export const startSpec = {
  resultSchema: StartAppResult,
  id: "app:start",
  recipePostInitAllowed: true,
  helpGroup: "common",
  mcpAllowed: true,
  summary: "Start the current Lando app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  streaming: StreamFrame,
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return withIncompleteStartNotice(
      Effect.andThen(refreshAppCache(), startApp(signal === undefined ? {} : { signal })),
    );
  },
  render: (result, _input, ctx) => renderStartAppResult(result as StartAppResult, ctx),
} satisfies LandoCommandSpec<StartAppResult>;
