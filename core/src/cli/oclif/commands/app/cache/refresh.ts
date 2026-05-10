/**
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

export const appCacheRefreshSpec: LandoCommandSpec<never> = {
  id: "app:cache:refresh",
  summary: "Rebuild the app plan, tooling graph, and command index without starting services.",
  namespace: "app",
  bootstrap: "app",
  run: () => Effect.die("not yet implemented: app:cache:refresh"),
};

export default class AppCacheRefreshCommand extends LandoCommandBase {
  static override description = appCacheRefreshSpec.summary;
  static override landoSpec: LandoCommandSpec = appCacheRefreshSpec;

  override async run(): Promise<void> {
    await this.runEffect(appCacheRefreshSpec);
  }
}
