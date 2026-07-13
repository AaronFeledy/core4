import { Flags } from "@oclif/core";

import type { IncludeVerifyReport } from "../../../../../landofile/includes.ts";
import {
  AppIncludesVerifyResultSchema,
  appIncludesVerify,
  renderIncludesVerifyResult,
} from "../../../../commands/app-includes-verify.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

const usesJsonFormat = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  "flags" in input &&
  typeof input.flags === "object" &&
  input.flags !== null &&
  "format" in input.flags &&
  input.flags.format === "json";

export const appIncludesVerifySpec: LandoCommandSpec<IncludeVerifyReport> = {
  resultSchema: AppIncludesVerifyResultSchema,
  id: "app:includes:verify",
  summary: "Verify the includes lockfile matches the resolved tree without updating it.",
  namespace: "app",
  bootstrap: "minimal",
  run: () => appIncludesVerify(),
  successExitCode: (result, input) => (result.ok || usesJsonFormat(input) ? undefined : 1),
  render: (result) => renderIncludesVerifyResult(result as IncludeVerifyReport, "text"),
};

export default class AppIncludesVerifyCommand extends LandoCommandBase {
  static override description = appIncludesVerifySpec.summary;
  static override flags = {
    format: Flags.string({
      description: "Output format.",
      options: ["text", "json"],
      default: "text",
    }),
  };
  static override landoSpec: LandoCommandSpec = appIncludesVerifySpec;
  static override bootstrap = appIncludesVerifySpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appIncludesVerifySpec);
  }
}
