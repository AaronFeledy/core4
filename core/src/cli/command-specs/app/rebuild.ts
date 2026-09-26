import { Effect } from "effect";

import { type RebuildAppResult, RebuildAppResultSchema, rebuildApp } from "@lando/engine/operations/rebuild";
import { refreshAppCache } from "../../commands/app-cache-refresh";
import { renderRebuildAppResult } from "../../commands/rebuild";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";

import { ServiceName, StreamFrame } from "@lando/sdk/schema";
import { Flags } from "../../spec/metadata";

export const rebuildOptionsFromInput = (input: unknown): NonNullable<Parameters<typeof rebuildApp>[0]> => {
  const signal = extractSpecAbortSignal(input);
  if (typeof input !== "object" || input === null) return signal === undefined ? {} : { signal };
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  const values = Array.isArray(flags.service)
    ? flags.service.filter((value): value is string => typeof value === "string")
    : typeof flags.service === "string"
      ? [flags.service]
      : [];
  const services = values.filter((value) => value.length > 0).map((value) => ServiceName.make(value));
  return {
    ...(services.length === 0 ? {} : { services }),
    ...(signal === undefined ? {} : { signal }),
  };
};

export const rebuildSpec: LandoCommandSpec<RebuildAppResult> = {
  resultSchema: RebuildAppResultSchema,
  id: "app:rebuild",
  helpGroup: "common",
  summary: "Rebuild artifacts and restart the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  usage: "[--service SERVICE]",
  flags: {
    service: Flags.string({
      char: "s",
      description: "Rebuild a specific planned service and its prerequisites (repeatable).",
      multiple: true,
    }),
  },
  streaming: StreamFrame,
  run: (input) => Effect.zipRight(refreshAppCache(), rebuildApp(rebuildOptionsFromInput(input))),
  render: (result, _input, ctx) => renderRebuildAppResult(result as RebuildAppResult, ctx),
};
