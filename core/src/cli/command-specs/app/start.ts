import { startApp } from "@lando/engine/operations/start";
import { withIncompleteStartNotice } from "@lando/engine/operations/start-incomplete-notice";
import { StartAppResult, StreamFrame } from "@lando/sdk/schema";
import { Effect } from "effect";
import { refreshAppCache } from "../../commands/app-cache-refresh";
import { renderStartAppResult } from "../../commands/start-result";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";
import { serviceNamesFlag, specFlagsOf } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";

/**
 * `lando app:start` — native command metadata adapter.
 */

export const startOptionsFromInput = (input: unknown): NonNullable<Parameters<typeof startApp>[0]> => {
  const signal = extractSpecAbortSignal(input);
  const services = serviceNamesFlag(specFlagsOf(input));
  return {
    ...(services.length === 0 ? {} : { services }),
    ...(signal === undefined ? {} : { signal }),
  };
};

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
  usage: "[--service SERVICE]",
  flags: {
    service: Flags.string({
      char: "s",
      description: "Service to start, with its prerequisites (repeatable).",
      multiple: true,
    }),
  },
  streaming: StreamFrame,
  run: (input) => {
    const options = startOptionsFromInput(input);
    return withIncompleteStartNotice(Effect.andThen(refreshAppCache(), startApp(options)), {
      verb: "start",
      ...(options.services === undefined ? {} : { services: options.services }),
    });
  },
  render: (result, _input, ctx) => renderStartAppResult(result, ctx),
} satisfies LandoCommandSpec<StartAppResult>;
