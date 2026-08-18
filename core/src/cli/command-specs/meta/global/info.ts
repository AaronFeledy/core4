import { Flags } from "../../../spec/metadata";

import {
  type GlobalInfoOptions,
  type GlobalInfoResult,
  GlobalInfoResultSchema,
  globalInfo,
  renderGlobalInfoResult,
} from "../../../commands/meta/global-info";
import type { LandoCommandSpec } from "../../../spec/command-base";

const stringArrayFlag = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" ? [value] : [];
};

export const globalInfoOptionsFromInput = (input: unknown): GlobalInfoOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  const services = stringArrayFlag(flags.service).filter((service) => service.length > 0);
  return services.length === 0 ? {} : { services };
};

export const metaGlobalInfoSpec: LandoCommandSpec<GlobalInfoResult> = {
  resultSchema: GlobalInfoResultSchema,
  id: "meta:global:info",
  summary: "Print runtime information for the host-level global Lando app.",
  description: "Print runtime information for the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:info",
  bootstrap: "global",
  flags: {
    service: Flags.string({
      char: "s",
      description: "Filter to a specific global service (repeatable).",
      multiple: true,
    }),
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  },
  run: (input) => globalInfo(globalInfoOptionsFromInput(input)),
  render: (result, _input, ctx) => renderGlobalInfoResult(result as GlobalInfoResult, ctx),
};
