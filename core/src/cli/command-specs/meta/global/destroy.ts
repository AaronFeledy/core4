import {
  type GlobalDestroyOptions,
  type GlobalDestroyResult,
  GlobalDestroyResultSchema,
  globalDestroy,
} from "@lando/engine/operations/global-destroy";
import { ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { renderGlobalDestroyResult } from "../../../commands/meta/global-destroy";
import { publishShutdownWarnings } from "../../../commands/shutdown-summary";
import { requireConfirmation } from "../../../require-confirmation";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { yesFlag } from "../../../spec/confirmation-flag";
import { specFlagsOf } from "../../../spec/input-coercion";
import { Flags } from "../../../spec/metadata";

export const globalDestroyOptionsFromInput = (input: unknown): GlobalDestroyOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = specFlagsOf(input);
  return {
    volumes: flags.volumes === true,
    purge: flags.purge === true,
    ...(typeof flags.provider === "string" ? { providerId: ProviderId.make(flags.provider) } : {}),
  };
};

const globalDestroyConfirmation = (deletes: {
  readonly volumes: boolean;
  readonly images: boolean;
}): string => {
  const items = [
    "containers",
    "networks",
    ...(deletes.volumes ? ["global data volumes"] : []),
    ...(deletes.images ? ["built images"] : []),
  ];
  const list = `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  return `Delete the global Lando app's ${list}?${deletes.volumes ? "" : " Global data volumes are kept."}`;
};

const runGlobalDestroy = Effect.fnUntraced(function* (input: unknown) {
  const flags = specFlagsOf(input);
  const purge = flags.purge === true;
  yield* requireConfirmation({
    yes: flags.yes === true,
    message: globalDestroyConfirmation({
      volumes: purge || flags.volumes === true,
      images: purge,
    }),
  });
  return yield* globalDestroy(globalDestroyOptionsFromInput(input)).pipe(Effect.tap(publishShutdownWarnings));
});

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
    yes: yesFlag("Skip the confirmation prompt."),
    volumes: Flags.boolean({
      description:
        "Also remove global service- and app-scoped data volumes; built images are released for reuse.",
      default: false,
    }),
    purge: Flags.boolean({
      description: "Also remove global service- and app-scoped data volumes and built images.",
      default: false,
    }),
  },
  run: runGlobalDestroy,
  render: (result) => renderGlobalDestroyResult(result),
} satisfies LandoCommandSpec<GlobalDestroyResult>;
