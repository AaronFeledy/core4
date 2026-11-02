import { Effect } from "effect";

import { rebuildApp } from "@lando/engine/operations/rebuild";
import { withIncompleteStartNotice } from "@lando/engine/operations/start-incomplete-notice";
import { RebuildAppResult, StreamFrame } from "@lando/sdk/schema";
import { refreshAppCache } from "../../commands/app-cache-refresh";
import { renderRebuildAppResult } from "../../commands/rebuild";
import { requireConfirmation } from "../../require-confirmation";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";
import { extractSpecFlags } from "../../spec/command-boundary";
import { yesFlag } from "../../spec/confirmation-flag";
import { serviceNamesFlag, specFlagsOf } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";

export const rebuildOptionsFromInput = (input: unknown): NonNullable<Parameters<typeof rebuildApp>[0]> => {
  const signal = extractSpecAbortSignal(input);
  const flags = specFlagsOf(input);
  const services = serviceNamesFlag(flags);
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
  return yield* withIncompleteStartNotice(Effect.andThen(refreshAppCache(), rebuildApp(options)));
});

export const rebuildSpec = {
  resultSchema: RebuildAppResult,
  id: "app:rebuild",
  helpGroup: "common",
  summary: "Rebuild artifacts and restart the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  usage: "[--service SERVICE] [--yes]",
  flags: {
    yes: yesFlag("Skip the confirmation prompt."),
    service: Flags.string({
      char: "s",
      description: "Rebuild a specific planned service and its prerequisites (repeatable).",
      multiple: true,
    }),
  },
  streaming: StreamFrame,
  run: runRebuildCommand,
  render: (result, _input, ctx) => renderRebuildAppResult(result, ctx),
} satisfies LandoCommandSpec<RebuildAppResult>;
