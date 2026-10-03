import { Effect } from "effect";

import { type RebuildAppResult, RebuildAppResultSchema, rebuildApp } from "@lando/engine/operations/rebuild";
import { refreshAppCache } from "../../commands/app-cache-refresh";
import { renderRebuildAppResult } from "../../commands/rebuild";
import { requireConfirmation } from "../../require-confirmation";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";
import { extractSpecFlags } from "../../spec/command-boundary";
import { specFlagsOf, stringArrayFlag } from "../../spec/input-coercion";

import { ServiceName, StreamFrame } from "@lando/sdk/schema";
import { Flags } from "../../spec/metadata";

export const rebuildOptionsFromInput = (input: unknown): NonNullable<Parameters<typeof rebuildApp>[0]> => {
  const signal = extractSpecAbortSignal(input);
  const flags = specFlagsOf(input);
  const values = stringArrayFlag(flags, "service");
  const services = values.filter((value) => value.length > 0).map((value) => ServiceName.make(value));
  return {
    ...(services.length === 0 ? {} : { services }),
    ...(signal === undefined ? {} : { signal }),
  };
};

export const runRebuildCommand = Effect.fn("RebuildCommand.run")(function* (input: unknown) {
  const options = rebuildOptionsFromInput(input);
  const target =
    options.services === undefined
      ? "this app"
      : `services ${options.services.join(", ")} and their prerequisites`;
  yield* requireConfirmation({
    yes: extractSpecFlags(input).yes === true,
    message: `Rebuild ${target}? This recreates containers and discards anything not in the Landofile or a volume.`,
  });
  yield* refreshAppCache();
  return yield* rebuildApp(options);
});

export const rebuildSpec: LandoCommandSpec<RebuildAppResult> = {
  resultSchema: RebuildAppResultSchema,
  id: "app:rebuild",
  helpGroup: "common",
  summary: "Rebuild artifacts and restart the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  usage: "[--service SERVICE] [--yes]",
  flags: {
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt.", default: false }),
    service: Flags.string({
      char: "s",
      description: "Rebuild a specific planned service and its prerequisites (repeatable).",
      multiple: true,
    }),
  },
  streaming: StreamFrame,
  run: runRebuildCommand,
  render: (result, _input, ctx) => renderRebuildAppResult(result as RebuildAppResult, ctx),
};
