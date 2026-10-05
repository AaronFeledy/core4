import { formatQuietSummary } from "@lando/renderer/summary";
/** `lando rebuild` result rendering. */
import type { RebuildAppResult } from "@lando/sdk/app";
import type { RenderContext } from "../renderer-boundary";
import { isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import { joinServiceRows, serviceStateRow } from "./service-summary";
import { buildStartSummary } from "./start-result";

export const renderRebuildAppResult = (result: RebuildAppResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx))
    return `\n${formatQuietSummary(buildStartSummary(result, "rebuild"), summaryPaintOptions(ctx))}`;
  const services = joinServiceRows(
    result.servicesStarted.map((service) => serviceStateRow(service.name, service.state, service.endpoints)),
  );
  return `rebuilt: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};
