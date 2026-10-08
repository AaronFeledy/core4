import { Effect } from "effect";

import {
  APPS_LIST_STATUSES,
  AppsListResultSchema,
  type AppsListStatus,
  type ListServicesResult,
  listServices,
  listServicesWithPrune,
  renderAppsListResult,
} from "../../commands/list";
import { MalformedCliFlagValueError } from "../../flag-value-validation";
import { Flags } from "../../spec/metadata";

import type { LandoCommandSpec } from "../../spec/command-base";
import { booleanFlag, formatFlag, specFlagsOf, stringArrayFlag, stringFlag } from "../../spec/input-coercion";

const extractFormat = (input: unknown): "json" | "table" =>
  formatFlag(specFlagsOf(input), ["json", "table"], "table");

const isAppsListStatus = (value: string): value is AppsListStatus =>
  (APPS_LIST_STATUSES as readonly string[]).includes(value);

const invalidStatusError = (): MalformedCliFlagValueError =>
  new MalformedCliFlagValueError({
    message: "--status has a malformed value.",
    flag: "status",
    issue: "invalid_option",
    remediation: `Supply --status with one of: ${APPS_LIST_STATUSES.join(", ")}.`,
  });

export const appsListPathFromInput = (input: unknown): string | undefined =>
  stringFlag(specFlagsOf(input), "path");

export const appsListHasFiltersFromInput = (input: unknown): boolean => {
  const flags = specFlagsOf(input);
  return stringFlag(flags, "path") !== undefined || stringArrayFlag(flags, "status").length > 0;
};

export const appsListStatusFromInput = (input: unknown): ReadonlyArray<AppsListStatus> | undefined => {
  const values = stringArrayFlag(specFlagsOf(input), "status");
  if (values.length === 0) return undefined;
  if (!values.every(isAppsListStatus)) throw invalidStatusError();
  return values;
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
  run: (input) =>
    Effect.gen(function* () {
      const path = appsListPathFromInput(input);
      const status = yield* Effect.try({
        try: () => appsListStatusFromInput(input),
        catch: (error) => (error instanceof MalformedCliFlagValueError ? error : invalidStatusError()),
      });
      const prune = appsListPruneFromInput(input);
      const includeScratch = appsListIncludeScratchFromInput(input);
      const options = {
        ...(path === undefined ? {} : { path }),
        ...(status === undefined ? {} : { status }),
        ...(includeScratch ? { includeScratch: true } : {}),
      };
      return yield* prune ? listServicesWithPrune(options) : listServices(options);
    }),
  render: (result, input, ctx) =>
    renderAppsListResult(result as ListServicesResult, extractFormat(input), ctx, {
      filtered: appsListHasFiltersFromInput(input),
    }),
};
