import { formatQuietSummary } from "@lando/renderer/summary";
/** `lando rebuild` result rendering. */
import type { RebuildAppResult } from "@lando/sdk/app";
import type { RenderContext } from "../renderer-boundary";
import { isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import { buildStartSummary } from "./start-result";

export const renderRebuildAppResult = (result: RebuildAppResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx))
    return `\n${formatQuietSummary(buildStartSummary(result, "rebuild"), summaryPaintOptions(ctx))}`;
  const services = result.servicesStarted
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  return `rebuilt: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};
