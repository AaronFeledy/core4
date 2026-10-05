import { Flags } from "../../../spec/metadata";

import {
  type GlobalInfoOptions,
  type GlobalInfoResult,
  GlobalInfoResultSchema,
  globalInfo,
  renderGlobalInfoResult,
} from "../../../commands/meta/global-info";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { serviceNamesFlag, specFlagsOf } from "../../../spec/input-coercion";

export const globalInfoOptionsFromInput = (input: unknown): GlobalInfoOptions => {
  const flags = specFlagsOf(input);
  const services = serviceNamesFlag(flags);
  return services.length === 0 ? {} : { services };
};

export const metaGlobalInfoSpec: LandoCommandSpec<GlobalInfoResult> = {
  resultSchema: GlobalInfoResultSchema,
  id: "meta:global:info",
  resultFormats: ["table"],
  summary: "Print runtime information for the host-level global Lando app.",
  description: "Print runtime information for the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:info",
  bootstrap: "global",
  flags: {
    service: Flags.string({
      char: "s",
      description: "Filter to a specific global service (repeatable).",
      multiple: true,
    }),
    format: Flags.string({
      description: "Output format.",
      default: "table",
    }),
  },
  run: (input) => globalInfo(globalInfoOptionsFromInput(input)),
  render: (result, _input, ctx) => renderGlobalInfoResult(result as GlobalInfoResult, ctx),
};
