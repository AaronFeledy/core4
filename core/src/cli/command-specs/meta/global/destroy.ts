import { ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { yesFlag } from "../../../spec/confirmation-flag";
import { Flags } from "../../../spec/metadata";

import {
  type GlobalDestroyOptions,
  type GlobalDestroyResult,
  GlobalDestroyResultSchema,
  globalDestroy,
} from "@lando/engine/operations/global-destroy";
import { renderGlobalDestroyResult } from "../../../commands/meta/global-destroy";
import { publishShutdownWarnings } from "../../../commands/shutdown-summary";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { specFlagsOf } from "../../../spec/input-coercion";

export const globalDestroyOptionsFromInput = (input: unknown): GlobalDestroyOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = specFlagsOf(input);
  return {
    yes: flags.yes === true,
    purge: flags.purge === true,
    ...(typeof flags.provider === "string" ? { providerId: ProviderId.make(flags.provider) } : {}),
  };
};

export const metaGlobalDestroySpec = {
  resultSchema: GlobalDestroyResultSchema,
  id: "meta:global:destroy",
  summary: "Destroy the host-level global Lando app provider resources.",
  description: "Destroy the host-level global Lando app provider resources.",
  namespace: "meta",
  topLevelAlias: "global:destroy",
  bootstrap: "global",
  flags: {
    provider: Flags.string({ description: "Destroy the global app only on this provider." }),
    yes: yesFlag("Confirm destruction of global app provider resources."),
    purge: Flags.boolean({
      description: "Also remove global service data volumes.",
      default: false,
    }),
  },
  run: (input) =>
    globalDestroy(globalDestroyOptionsFromInput(input)).pipe(Effect.tap(publishShutdownWarnings)),
  render: (result) => renderGlobalDestroyResult(result),
} satisfies LandoCommandSpec<GlobalDestroyResult>;
