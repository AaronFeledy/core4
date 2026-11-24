import { stopApp } from "@lando/engine/operations/stop";
import { StopAppResult } from "@lando/sdk/schema";
import { Effect } from "effect";
import { publishShutdownWarnings } from "../../commands/shutdown-summary";
import { renderStopAppResult } from "../../commands/stop";
import type { LandoCommandSpec } from "../../spec/command-base";
import { serviceNamesFlag, specFlagsOf } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";

/**
 * `lando app:stop` — native command metadata adapter.
 */

export const stopOptionsFromInput = (input: unknown): NonNullable<Parameters<typeof stopApp>[0]> => {
  const services = serviceNamesFlag(specFlagsOf(input));
  return services.length === 0 ? {} : { services };
};

export const stopSpec: LandoCommandSpec<StopAppResult> = {
  resultSchema: StopAppResult,
  id: "app:stop",
  helpGroup: "common",
  mcpAllowed: true,
  summary: "Stop the current Lando app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  usage: "[--service SERVICE]",
  flags: {
    service: Flags.string({
      char: "s",
      description: "Service to stop, without stopping its dependents (repeatable)",
      multiple: true,
    }),
  },
  run: (input) => stopApp(stopOptionsFromInput(input)).pipe(Effect.tap(publishShutdownWarnings)),
  render: (result) => renderStopAppResult(result),
};
