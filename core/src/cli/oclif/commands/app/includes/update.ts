import { Args, Flags } from "@oclif/core";

import type { IncludeUpdateReport } from "../../../../../landofile/includes.ts";
import {
  AppIncludesUpdateResultSchema,
  appIncludesUpdate,
  renderIncludesUpdateResult,
} from "../../../../commands/app-includes-update.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

const inputFlags = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null && "flags" in input
    ? ((input as { flags?: Record<string, unknown> }).flags ?? {})
    : {};

const checkFromInput = (input: unknown): boolean => inputFlags(input).check === true;

const noNetworkFromInput = (input: unknown): boolean => inputFlags(input)["no-network"] === true;

const sourcesFromInput = (input: unknown): ReadonlyArray<string> => {
  if (typeof input !== "object" || input === null || !("argv" in input)) return [];
  const argv = (input as { argv: unknown }).argv;
  if (!Array.isArray(argv)) return [];
  return argv.filter((value): value is string => typeof value === "string" && !value.startsWith("-"));
};

export const appIncludesUpdateSpec: LandoCommandSpec<IncludeUpdateReport> = {
  resultSchema: AppIncludesUpdateResultSchema,
  id: "app:includes:update",
  summary: "Refresh includes lockfile entries; scope to named sources and run offline with --no-network.",
  namespace: "app",
  bootstrap: "minimal",
  run: (input) =>
    appIncludesUpdate({
      check: checkFromInput(input),
      noNetwork: noNetworkFromInput(input),
      sources: sourcesFromInput(input),
    }),
  successExitCode: (result) => (result.checkMode && result.drift ? 1 : undefined),
  render: (result) => renderIncludesUpdateResult(result as IncludeUpdateReport, "text"),
};

export default class AppIncludesUpdateCommand extends LandoCommandBase {
  static override description = appIncludesUpdateSpec.summary;
  static override strict = false;
  static override args = {
    source: Args.string({
      description: "Include source to refresh (repeatable). Omit to refresh every source.",
      required: false,
    }),
  };
  static override flags = {
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
  };
  static override landoSpec: LandoCommandSpec<IncludeUpdateReport> = appIncludesUpdateSpec;
  static override bootstrap = appIncludesUpdateSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appIncludesUpdateSpec);
  }
}
