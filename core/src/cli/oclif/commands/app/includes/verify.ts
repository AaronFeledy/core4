import { Flags } from "@oclif/core";

import type { IncludeVerifyReport } from "../../../../../landofile/includes.ts";
import {
  type AppIncludesVerifyFormat,
  appIncludesVerify,
  renderIncludesVerifyResult,
} from "../../../../commands/app-includes-verify.ts";
import { EmptyResultSchema, LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

export const appIncludesVerifySpec: LandoCommandSpec<IncludeVerifyReport> = {
  resultSchema: EmptyResultSchema,
  id: "app:includes:verify",
  summary: "Verify the includes lockfile matches the resolved tree without updating it.",
  namespace: "app",
  bootstrap: "minimal",
  run: () => appIncludesVerify(),
  render: (result) => renderIncludesVerifyResult(result as IncludeVerifyReport),
};

const formatFromFlag = (value: unknown): AppIncludesVerifyFormat => (value === "json" ? "json" : "text");

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
    const parsed = (await this.parse(AppIncludesVerifyCommand)) as {
      readonly flags: { readonly format?: string };
    };
    const format = formatFromFlag(parsed.flags.format);
    await this.runEffect({
      ...appIncludesVerifySpec,
      render: (result) => renderIncludesVerifyResult(result as IncludeVerifyReport, format),
    });
  }
}
