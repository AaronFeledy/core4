import { Effect } from "effect";

import { type RestartAppResult, RestartAppResultSchema, restartApp } from "@lando/engine/operations/restart";
import { refreshAppCache } from "../../commands/app-cache-refresh";
import { renderRestartAppResult } from "../../commands/restart";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";
import { serviceNamesFlag, specFlagsOf } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";

export const restartOptionsFromInput = (input: unknown): NonNullable<Parameters<typeof restartApp>[0]> => {
  const signal = extractSpecAbortSignal(input);
  const services = serviceNamesFlag(specFlagsOf(input));
  return {
    ...(services.length === 0 ? {} : { services }),
    ...(signal === undefined ? {} : { signal }),
  };
};

export const restartSpec: LandoCommandSpec<RestartAppResult> = {
  resultSchema: RestartAppResultSchema,
  id: "app:restart",
  helpGroup: "common",
  mcpAllowed: true,
  summary: "Restart the current app (stop + start).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  usage: "[--service SERVICE]",
  flags: {
    service: Flags.string({
      char: "s",
      description: "Restart a specific planned service without pulling in dependencies (repeatable).",
      multiple: true,
    }),
  },
  run: (input) => Effect.andThen(refreshAppCache(), restartApp(restartOptionsFromInput(input))),
  render: (result) => renderRestartAppResult(result as RestartAppResult),
};
