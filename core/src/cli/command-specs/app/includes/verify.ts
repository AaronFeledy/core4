import { Flags } from "../../../spec/metadata";

import type { IncludeVerifyReport } from "@lando/landofile/includes";
import type { StateStore } from "@lando/sdk/services";
import type { AppIncludesVerifyError } from "../../../commands/app-includes-verify";
import {
  AppIncludesVerifyResultSchema,
  appIncludesVerify,
  renderIncludesVerifyResult,
} from "../../../commands/app-includes-verify";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const appIncludesVerifySpec: LandoCommandSpec<
  IncludeVerifyReport,
  AppIncludesVerifyError,
  StateStore
> = {
  resultSchema: AppIncludesVerifyResultSchema,
  id: "app:includes:verify",
  summary:
    "Verify the includes lockfile pins every remote include and the pinned content matches, without updating it.",
  namespace: "app",
  bootstrap: "minimal",
  flags: {
    format: Flags.string({
      description: "Output format.",
      default: "text",
    }),
  },
  run: () => appIncludesVerify(),
  completion: (result) => ({ ok: true, exitCode: result.ok ? 0 : 1 }),
  render: (result) => renderIncludesVerifyResult(result, "text"),
};
