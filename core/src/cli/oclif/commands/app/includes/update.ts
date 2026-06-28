import { Flags } from "@oclif/core";

import type { IncludeUpdateReport } from "../../../../../landofile/includes.ts";
import { appIncludesUpdate, renderIncludesUpdateResult } from "../../../../commands/app-includes-update.ts";
import { EmptyResultSchema, LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

export const appIncludesUpdateSpec: LandoCommandSpec<IncludeUpdateReport> = {
  resultSchema: EmptyResultSchema,
  id: "app:includes:update",
  summary: "Refresh every includes lockfile entry to its latest source-resolved version.",
  namespace: "app",
  bootstrap: "minimal",
  run: (input) => appIncludesUpdate({ check: checkFromInput(input) }),
  render: (result, _input, ctx) =>
    renderIncludesUpdateResult(result as IncludeUpdateReport, ctx?.format === "json" ? "json" : "text"),
};

const checkFromInput = (input: unknown): boolean =>
  typeof input === "object" && input !== null && "flags" in input
    ? (input as { flags?: { check?: boolean } }).flags?.check === true
    : false;

export default class AppIncludesUpdateCommand extends LandoCommandBase {
  static override description = appIncludesUpdateSpec.summary;
  static override flags = {
    check: Flags.boolean({
      description: "Report would-be lockfile drift without writing.",
      default: false,
    }),
    format: Flags.string({
      description: "Output format.",
      options: ["text", "json"],
      default: "text",
    }),
  };
  static override landoSpec: LandoCommandSpec = appIncludesUpdateSpec;
  static override bootstrap = appIncludesUpdateSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = (await this.parse(AppIncludesUpdateCommand)) as {
      readonly flags: { readonly check?: boolean; readonly format?: string };
    };
    const check = parsed.flags.check === true;
    await this.runEffect({
      ...appIncludesUpdateSpec,
      run: () => appIncludesUpdate({ check }),
    });
  }
}
