import { Args, Flags } from "../../../spec/metadata";

import type { IncludeUpdateReport } from "@lando/landofile/includes";
import {
  type AppIncludesUpdateError,
  AppIncludesUpdateResultSchema,
  appIncludesUpdate,
  renderIncludesUpdateResult,
} from "../../../commands/app-includes-update";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { extractSpecParsedArgv } from "../../../spec/command-boundary";

const inputFlags = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null && "flags" in input
    ? ((input as { flags?: Record<string, unknown> }).flags ?? {})
    : {};

const checkFromInput = (input: unknown): boolean => inputFlags(input).check === true;

const noNetworkFromInput = (input: unknown): boolean => inputFlags(input)["no-network"] === true;

const sourcesFromInput = (input: unknown): ReadonlyArray<string> => {
  return extractSpecParsedArgv(input).filter((value) => !value.startsWith("-"));
};

export const appIncludesUpdateSpec: LandoCommandSpec<IncludeUpdateReport, AppIncludesUpdateError, never> = {
  resultSchema: AppIncludesUpdateResultSchema,
  id: "app:includes:update",
  summary: "Refresh includes lockfile entries; scope to named sources and run offline with --no-network.",
  namespace: "app",
  bootstrap: "minimal",
  strict: false,
  args: {
    source: Args.string({
      description: "Include source to refresh (repeatable). Omit to refresh every source.",
      required: false,
    }),
  },
  flags: {
    check: Flags.boolean({
      description: "Report would-be lockfile drift without writing.",
      default: false,
    }),
    "no-network": Flags.boolean({
      description: "Update strictly from cache and lockfile state; never touch the network.",
      default: false,
    }),
    format: Flags.string({
      description: "Output format.",
      options: ["text", "json"],
      default: "text",
    }),
  },
  run: (input) =>
    appIncludesUpdate({
      check: checkFromInput(input),
      noNetwork: noNetworkFromInput(input),
      sources: sourcesFromInput(input),
    }),
  successExitCode: (result) => (result.checkMode && result.drift ? 1 : undefined),
  render: (result) => renderIncludesUpdateResult(result as IncludeUpdateReport, "text"),
};
