import {
  type GlobalStopOptions,
  type GlobalStopResult,
  GlobalStopResultSchema,
  globalStop,
} from "@lando/engine/operations/global-stop";
import { Effect } from "effect";
import { renderGlobalStopResult } from "../../../commands/meta/global-stop";
import { publishShutdownWarnings } from "../../../commands/shutdown-summary";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { specFlagsOf, stringArrayFlag } from "../../../spec/input-coercion";
import { Flags } from "../../../spec/metadata";

export const globalStopOptionsFromInput = (input: unknown): GlobalStopOptions => {
  const services = stringArrayFlag(specFlagsOf(input), "service");
  return services.length === 0 ? {} : { services };
};

export const metaGlobalStopSpec = {
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
  run: (input) => globalStop(globalStopOptionsFromInput(input)).pipe(Effect.tap(publishShutdownWarnings)),
  render: (result) => renderGlobalStopResult(result),
} satisfies LandoCommandSpec<GlobalStopResult>;
