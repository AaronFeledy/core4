import { Flags } from "../../spec/metadata";

import { AppInfoResultSchema, type InfoAppResult, infoApp } from "@lando/engine/operations/info";
import { renderInfoAppResult } from "../../commands/info-render";
import type { LandoCommandSpec } from "../../spec/command-base";
import { serviceNamesFlag, specFlagsOf } from "../../spec/input-coercion";

/**
 * `lando app:info` — native command metadata adapter.
 */

export const infoOptionsFromInput = (input: unknown): NonNullable<Parameters<typeof infoApp>[0]> => {
  const flags = specFlagsOf(input);
  const services = serviceNamesFlag(flags);
  return {
    ...(flags.deep === true ? { deep: true } : {}),
    ...(services.length === 0 ? {} : { services }),
  };
};

export const infoSpec: LandoCommandSpec<InfoAppResult> = {
  resultSchema: AppInfoResultSchema,
  id: "app:info",
  helpGroup: "common",
  mcpAllowed: true,
  summary: "Print provider-neutral runtime info for the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  flags: {
    deep: Flags.boolean({
      description: "Include the host agent-context env names actually forwarded.",
      default: false,
    }),
    service: Flags.string({
      char: "s",
      description: "Inspect a specific planned service (repeatable).",
      multiple: true,
    }),
  },
  run: (input) => infoApp(infoOptionsFromInput(input)),
  render: (result, _input, ctx) => renderInfoAppResult(result as InfoAppResult, ctx),
};
