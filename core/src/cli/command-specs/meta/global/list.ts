import { Effect } from "effect";
import { Flags } from "../../../spec/metadata";

import {
  DefaultGlobalListLayer,
  type GlobalListResult,
  GlobalListResultSchema,
  globalList,
  renderGlobalListResult,
} from "../../../commands/meta/global-list";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const metaGlobalListSpec: LandoCommandSpec<GlobalListResult> = {
  resultSchema: GlobalListResultSchema,
  id: "meta:global:list",
  summary:
    "List every contributed global service, its source plugin, enabled state, and per-service commands.",
  description:
    "List every contributed global service, its source plugin, enabled state, and per-service commands.",
  namespace: "meta",
  topLevelAlias: "global:list",
  bootstrap: "minimal",
  flags: {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  },
  run: () => globalList().pipe(Effect.provide(DefaultGlobalListLayer)),
  render: (result, _input, ctx) => renderGlobalListResult(result as GlobalListResult, ctx),
};
