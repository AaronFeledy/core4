import {
  AppsListResultSchema,
  type ListServicesResult,
  listServices,
  listServicesWithPrune,
  renderAppsListResult,
} from "../../commands/list";
import { Flags } from "../../spec/metadata";

import type { LandoCommandSpec } from "../../spec/command-base";

const extractFormat = (input: unknown): "json" | "table" => {
  if (typeof input !== "object" || input === null) return "table";
  const flags = (input as { flags?: { format?: unknown } }).flags;
  return flags?.format === "json" ? "json" : "table";
};

export const appsListPathFromInput = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const flags = (input as { flags?: { path?: unknown } }).flags;
  return typeof flags?.path === "string" ? flags.path : undefined;
};

export const appsListPruneFromInput = (input: unknown): boolean => {
  if (typeof input !== "object" || input === null) return false;
  const flags = (input as { flags?: { prune?: unknown } }).flags;
  return flags?.prune === true;
};

export const listSpec: LandoCommandSpec<ListServicesResult> = {
  resultSchema: AppsListResultSchema,
  id: "apps:list",
  resultFormats: ["table"],
  mcpAllowed: true,
  helpGroup: "common",
  summary: "List Lando apps applied across discovered providers on this host.",
  namespace: "apps",
  topLevelAlias: true,
  aliases: ["list"],
  bootstrap: "minimal",
  flags: {
    format: Flags.string({ description: "Output format.", default: "table" }),
    path: Flags.string({ description: "Filter apps whose root contains the given substring." }),
    prune: Flags.boolean({ description: "Remove stale inventory only after provider absence is confirmed." }),
  },
  run: (input) => {
    const path = appsListPathFromInput(input);
    const prune = appsListPruneFromInput(input);
    const options = path === undefined ? {} : { path };
    return prune ? listServicesWithPrune(options) : listServices(options);
  },
  render: (result, input?: unknown) =>
    renderAppsListResult(result as ListServicesResult, extractFormat(input)),
};
