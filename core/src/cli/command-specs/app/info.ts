import { Flags } from "../../spec/metadata";

import { AppInfoResultSchema, type InfoAppResult, infoApp } from "@lando/engine/operations/info";
import { renderInfoAppResult } from "../../commands/info-render";
/**
 * `lando app:info` — native command metadata adapter.
 */
import type { LandoCommandSpec } from "../../spec/command-base";

const infoDeepFromInput = (input: unknown): boolean => {
  if (typeof input !== "object" || input === null) return false;
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  return flags.deep === true;
};

export const infoSpec: LandoCommandSpec<InfoAppResult> = {
  resultSchema: AppInfoResultSchema,
  id: "app:info",
  mcpAllowed: true,
  summary: "Print provider-neutral runtime info for the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  flags: {
    deep: Flags.boolean({
      description: "Include the resolved host agent-context env forwarding allowlist.",
      default: false,
    }),
  },
  run: (input) => infoApp({ deep: infoDeepFromInput(input) }),
  render: (result, _input, ctx) => renderInfoAppResult(result as InfoAppResult, ctx),
};
