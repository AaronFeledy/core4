import {
  APPS_LIST_STATUSES,
  AppsListResultSchema,
  type AppsListStatus,
  type ListServicesResult,
  listServices,
  listServicesWithPrune,
  renderAppsListResult,
} from "../../commands/list";
import { Flags } from "../../spec/metadata";

import type { LandoCommandSpec } from "../../spec/command-base";
import { booleanFlag, formatFlag, specFlagsOf, stringArrayFlag, stringFlag } from "../../spec/input-coercion";

const extractFormat = (input: unknown): "json" | "table" =>
  formatFlag(specFlagsOf(input), ["json", "table"], "table");

const isAppsListStatus = (value: string): value is AppsListStatus =>
  (APPS_LIST_STATUSES as readonly string[]).includes(value);

export const appsListPathFromInput = (input: unknown): string | undefined =>
  stringFlag(specFlagsOf(input), "path");

export const appsListStatusFromInput = (input: unknown): ReadonlyArray<AppsListStatus> | undefined => {
  const values = stringArrayFlag(specFlagsOf(input), "status");
  if (values.length === 0) return undefined;
  return values.filter(isAppsListStatus);
};

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
    status: Flags.string({
      description: "Filter apps by runtime status (repeatable).",
      multiple: true,
      options: APPS_LIST_STATUSES,
    }),
    prune: Flags.boolean({ description: "Remove stale inventory only after provider absence is confirmed." }),
    "include-scratch": Flags.boolean({ description: "Include running scratch apps in the inventory." }),
    all: Flags.boolean({ description: "Include scratch apps along with every discovered user app." }),
  },
  run: (input) => {
    const path = appsListPathFromInput(input);
    const status = appsListStatusFromInput(input);
    const prune = appsListPruneFromInput(input);
    const includeScratch = appsListIncludeScratchFromInput(input);
    const options = {
      ...(path === undefined ? {} : { path }),
      ...(status === undefined ? {} : { status }),
      ...(includeScratch ? { includeScratch: true } : {}),
    };
    return prune ? listServicesWithPrune(options) : listServices(options);
  },
  render: (result, input, ctx) =>
    renderAppsListResult(result as ListServicesResult, extractFormat(input), ctx),
};
