import { formatQuietSummary } from "@lando/renderer/summary";
/** `lando rebuild` result rendering. */
import type { RebuildAppResult } from "@lando/sdk/app";
import type { RenderContext } from "../renderer-boundary";
import { isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import { lifecycleLine, serviceRowsText } from "./service-summary";
import { buildStartSummary } from "./start-result";

export const renderRebuildAppResult = (result: RebuildAppResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx))
    return `\n${formatQuietSummary(buildStartSummary(result, "rebuild"), summaryPaintOptions(ctx))}`;
  return lifecycleLine("rebuilt", result.app, serviceRowsText(result.servicesStarted));
};
