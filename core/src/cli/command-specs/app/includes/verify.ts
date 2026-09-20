import { Flags } from "../../../spec/metadata";

import type { IncludeVerifyReport } from "@lando/landofile/includes";
import type { StateStore } from "@lando/sdk/services";
import type { AppIncludesVerifyError } from "../../../commands/app-includes-verify";
import {
  AppIncludesVerifyResultSchema,
  appIncludesVerify,
  renderIncludesVerifyResult,
} from "../../../commands/app-includes-verify";
import { isEnvelopeResultFormat } from "../../../format-flags";
import type { LandoCommandSpec } from "../../../spec/command-base";

const usesEnvelopeFormat = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  "flags" in input &&
  typeof input.flags === "object" &&
  input.flags !== null &&
  "format" in input.flags &&
  typeof input.flags.format === "string" &&
  isEnvelopeResultFormat(input.flags.format);

export const appIncludesVerifySpec: LandoCommandSpec<
  IncludeVerifyReport,
  AppIncludesVerifyError,
  StateStore
> = {
  resultSchema: AppIncludesVerifyResultSchema,
  id: "app:includes:verify",
  summary: "Verify the includes lockfile matches the resolved tree without updating it.",
  namespace: "app",
  bootstrap: "minimal",
  flags: {
    format: Flags.string({
      description: "Output format.",
      default: "text",
    }),
  },
  run: () => appIncludesVerify(),
  successExitCode: (result, input) => (result.ok || usesEnvelopeFormat(input) ? undefined : 1),
  render: (result) => renderIncludesVerifyResult(result as IncludeVerifyReport, "text"),
};
