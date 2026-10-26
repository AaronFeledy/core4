/** `lando restart` result rendering. */
import type { RestartAppResult } from "@lando/sdk/app";

import { linkKnownHttpUrls } from "@lando/renderer/console-layout";
import { type SummaryDocument, formatQuietSummary } from "@lando/renderer/summary";
import type { RenderContext } from "../renderer-boundary";
import { contextAllowsHyperlinks, isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import { connectionFields, unambiguousHostHttpUrls } from "./connection-summary";
import { lifecycleLine, serviceRowsText } from "./service-summary";
import { startOutcome, startStatusTone } from "./start-result";

// Restart answers "which services came back, and where do I reach each one",
// so every service keeps both of its scopes under its own row, as the plain
// line does, instead of start's one deduplicated host list.
export const buildRestartSummary = (result: RestartAppResult): SummaryDocument => {
  const rows = result.servicesStarted.map((service) => ({
    label: service.name,
    tone: startStatusTone(service.state),
    value: service.state,
    fields: connectionFields(service.connections),
  }));
  return {
    title: "Restarted",
    ...startOutcome(result),
    sections: [
      {
        title: "Services",
        rows,
        ...(rows.length === 0 ? { notes: ["No services were restarted."] } : {}),
      },
    ],
  };
};

// Links must open from the host, so app-network and unverified addresses stay plain text.
const restartHttpUrls = (result: RestartAppResult): ReadonlyArray<string> =>
  unambiguousHostHttpUrls(result.servicesStarted.flatMap((service) => service.connections));

export const renderRestartAppResult = (result: RestartAppResult, ctx?: RenderContext): string => {
  if (!isDecoratedContext(ctx)) {
    return lifecycleLine("restarted", result.app, serviceRowsText(result.servicesStarted));
  }
  const rendered = `\n${formatQuietSummary(buildRestartSummary(result), summaryPaintOptions(ctx))}`;
  return contextAllowsHyperlinks(ctx) ? linkKnownHttpUrls(rendered, restartHttpUrls(result)) : rendered;
};
