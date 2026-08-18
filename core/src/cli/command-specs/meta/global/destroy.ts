import { Flags } from "../../../spec/metadata";

import {
  type GlobalDestroyOptions,
  type GlobalDestroyResult,
  GlobalDestroyResultSchema,
  globalDestroy,
  renderGlobalDestroyResult,
} from "../../../commands/meta/global-destroy";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const globalDestroyOptionsFromInput = (input: unknown): GlobalDestroyOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  return { yes: flags.yes === true, purge: flags.purge === true };
};

export const metaGlobalDestroySpec: LandoCommandSpec<GlobalDestroyResult> = {
  resultSchema: GlobalDestroyResultSchema,
  id: "meta:global:destroy",
  summary: "Destroy the host-level global Lando app provider resources.",
  description: "Destroy the host-level global Lando app provider resources.",
  namespace: "meta",
  topLevelAlias: "global:destroy",
  bootstrap: "global",
  flags: {
    yes: Flags.boolean({
      char: "y",
      description: "Confirm destruction of global app provider resources.",
      default: false,
    }),
    purge: Flags.boolean({
      description: "Also remove global service data volumes.",
      default: false,
    }),
  },
  run: (input) => globalDestroy(globalDestroyOptionsFromInput(input)),
  render: (result) => renderGlobalDestroyResult(result as GlobalDestroyResult),
};
