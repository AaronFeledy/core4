/**
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

export const appIncludesUpdateSpec: LandoCommandSpec<never> = {
  id: "app:includes:update",
  summary: "Refresh one or more includes lockfile entries.",
  namespace: "app",
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: app:includes:update"),
};

export default class AppIncludesUpdateCommand extends LandoCommandBase {
  static override description = appIncludesUpdateSpec.summary;
  static override landoSpec: LandoCommandSpec = appIncludesUpdateSpec;

  override async run(): Promise<void> {
    await this.runEffect(appIncludesUpdateSpec);
  }
}
