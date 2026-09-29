import {
  AppsListResultSchema,
  type ListServicesResult,
  listServices,
  listServicesWithPrune,
  renderAppsListResult,
} from "../../commands/list";
import { Flags } from "../../spec/metadata";

import type { LandoCommandSpec } from "../../spec/command-base";
import { booleanFlag, formatFlag, specFlagsOf, stringFlag } from "../../spec/input-coercion";

const extractFormat = (input: unknown): "json" | "table" =>
  formatFlag(specFlagsOf(input), ["json", "table"], "table");

export const appsListPathFromInput = (input: unknown): string | undefined =>
  stringFlag(specFlagsOf(input), "path");

export const appsListPruneFromInput = (input: unknown): boolean => booleanFlag(specFlagsOf(input), "prune");

export const appsListIncludeScratchFromInput = (input: unknown): boolean => {
  const flags = specFlagsOf(input);
  return booleanFlag(flags, "include-scratch") || booleanFlag(flags, "all");
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
    "include-scratch": Flags.boolean({ description: "Include running scratch apps in the inventory." }),
    all: Flags.boolean({ description: "Include scratch apps along with every discovered user app." }),
  },
  run: (input) => {
    const path = appsListPathFromInput(input);
    const prune = appsListPruneFromInput(input);
    const includeScratch = appsListIncludeScratchFromInput(input);
    const options = {
      ...(path === undefined ? {} : { path }),
      ...(includeScratch ? { includeScratch: true } : {}),
    };
    return prune ? listServicesWithPrune(options) : listServices(options);
  },
  render: (result, input?: unknown) =>
    renderAppsListResult(result as ListServicesResult, extractFormat(input)),
};
