import {
  type GlobalStopOptions,
  type GlobalStopResult,
  GlobalStopResultSchema,
  globalStop,
  renderGlobalStopResult,
} from "../../../commands/meta/global-stop";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { specFlagsOf, stringArrayFlag } from "../../../spec/input-coercion";
import { Flags } from "../../../spec/metadata";

export const globalStopOptionsFromInput = (input: unknown): GlobalStopOptions => {
  const services = stringArrayFlag(specFlagsOf(input), "service");
  return services.length === 0 ? {} : { services };
};

export const metaGlobalStopSpec: LandoCommandSpec<GlobalStopResult> = {
  resultSchema: GlobalStopResultSchema,
  id: "meta:global:stop",
  summary: "Stop the host-level global Lando app.",
  description: "Stop the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:stop",
  bootstrap: "global",
  usage: "[--service SERVICE]",
  flags: {
    service: Flags.string({
      char: "s",
      description: "Stop a specific global service (repeatable).",
      multiple: true,
    }),
  },
  run: (input) => globalStop(globalStopOptionsFromInput(input)),
  render: (result) => renderGlobalStopResult(result as GlobalStopResult),
};
