import {
  type AppCacheRefreshResult,
  AppCacheRefreshResultSchema,
  refreshAppCache,
  renderAppCacheRefreshResult,
} from "../../../commands/app-cache-refresh";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const appCacheRefreshSpec: LandoCommandSpec<AppCacheRefreshResult> = {
  resultSchema: AppCacheRefreshResultSchema,
  id: "app:cache:refresh",
  summary: "Rebuild the app plan, tooling graph, and command index without starting services.",
  namespace: "app",
  bootstrap: "app",
  run: () => refreshAppCache(),
  render: (result) => renderAppCacheRefreshResult(result as AppCacheRefreshResult),
};
