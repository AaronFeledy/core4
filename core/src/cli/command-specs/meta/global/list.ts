import { Flags } from "../../../spec/metadata";

import {
  type GlobalListResult,
  GlobalListResultSchema,
  globalList,
} from "@lando/engine/operations/global-list";
import { renderGlobalListResult } from "../../../commands/meta/global-list";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const metaGlobalListSpec: LandoCommandSpec<GlobalListResult> = {
  resultSchema: GlobalListResultSchema,
  id: "meta:global:list",
  resultFormats: ["table"],
  summary:
    "List every contributed global service, its source plugin, enabled state, and per-service commands.",
  description:
    "List every contributed global service, its source plugin, enabled state, and per-service commands.",
  namespace: "meta",
  topLevelAlias: "global:list",
  bootstrap: "plugins",
  flags: {
    format: Flags.string({
      description: "Output format.",
      default: "table",
    }),
  },
  run: () => globalList(),
  render: (result, _input, ctx) => renderGlobalListResult(result, ctx),
};
