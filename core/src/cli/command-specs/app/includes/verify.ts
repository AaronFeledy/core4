import { Flags } from "../../../spec/metadata";

import type { IncludeVerifyReport } from "@lando/landofile/includes";
import {
  AppIncludesVerifyResultSchema,
  appIncludesVerify,
  renderIncludesVerifyResult,
} from "../../../commands/app-includes-verify";
import type { LandoCommandSpec } from "../../../spec/command-base";

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
  flags: {
    format: Flags.string({
      description: "Output format.",
      options: ["text", "json"],
      default: "text",
    }),
  },
  run: () => appIncludesVerify(),
  successExitCode: (result, input) => (result.ok || usesJsonFormat(input) ? undefined : 1),
  render: (result) => renderIncludesVerifyResult(result as IncludeVerifyReport, "text"),
};
