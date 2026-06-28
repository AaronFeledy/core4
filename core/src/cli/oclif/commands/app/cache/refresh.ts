import {
  type AppCacheRefreshResult,
  refreshAppCache,
  renderAppCacheRefreshResult,
} from "../../../../commands/app-cache-refresh.ts";
import { EmptyResultSchema, LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

export const appCacheRefreshSpec: LandoCommandSpec<AppCacheRefreshResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:cache:refresh",
  summary: "Rebuild the app plan, tooling graph, and command index without starting services.",
  namespace: "app",
  bootstrap: "app",
  run: () => refreshAppCache(),
  render: (result) => renderAppCacheRefreshResult(result as AppCacheRefreshResult),
};

export default class AppCacheRefreshCommand extends LandoCommandBase {
  static override description = appCacheRefreshSpec.summary;
  static override landoSpec: LandoCommandSpec = appCacheRefreshSpec;
  static override bootstrap = appCacheRefreshSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appCacheRefreshSpec);
  }
}
