/**
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

export const appIncludesVerifySpec: LandoCommandSpec<never> = {
  id: "app:includes:verify",
  summary: "Re-check every includes checksum without updating.",
  namespace: "app",
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: app:includes:verify"),
};

export default class AppIncludesVerifyCommand extends LandoCommandBase {
  static override description = appIncludesVerifySpec.summary;
  static override landoSpec: LandoCommandSpec = appIncludesVerifySpec;

  override async run(): Promise<void> {
    await this.runEffect(appIncludesVerifySpec);
  }
}
