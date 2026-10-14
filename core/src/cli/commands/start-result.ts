/** `lando start` result rendering. */
import type { StartAppResult } from "@lando/sdk/app";

import { type SummaryDocument, formatQuietSummary } from "@lando/renderer/summary";
import type { RenderContext } from "../renderer-boundary";
import { isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import { START_STATUS_TONES, lifecycleLine, serviceRowsText, summaryToneFromTable } from "./service-summary";

const startStatusTone = summaryToneFromTable(START_STATUS_TONES, "warn");

const uniqueEndpoints = (services: StartAppResult["servicesStarted"]): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const https: string[] = [];
  const http: string[] = [];
  const other: string[] = [];
  for (const service of services) {
    for (const endpoint of service.endpoints) {
      if (seen.has(endpoint)) continue;
      seen.add(endpoint);
      if (endpoint.startsWith("https://")) https.push(endpoint);
      else if (endpoint.startsWith("http://")) http.push(endpoint);
      else other.push(endpoint);
    }
  }
  return [...https, ...http, ...other];
};

const isWebUrl = (url: string): boolean => url.startsWith("https://") || url.startsWith("http://");

const serviceNoun = (count: number): string => (count === 1 ? "service" : "services");

export const buildStartSummary = (
  result: StartAppResult,
  action: "start" | "rebuild" = "start",
): SummaryDocument => {
  const urls = uniqueEndpoints(result.servicesStarted);
  const httpsRests = new Set(
    urls.flatMap((url) => (url.startsWith("https://") ? [url.slice("https://".length)] : [])),
  );
  const rows = result.servicesStarted.map((service) => ({
    label: service.name,
    tone: startStatusTone(service.state),
    value: service.state,
  }));
  const total = result.servicesStarted.length;
  const restarting = result.servicesStarted.filter((service) => service.state === "restarting").length;
  const ready = total - restarting;
  const noun = serviceNoun(total);
  return {
    title: action === "rebuild" ? "Rebuilt" : "Started",
    tone: restarting === 0 ? "ok" : "warn",
    subtitle: restarting === 0 ? `${result.app} is ready` : `${result.app} started with restarting services`,
    sections: [
      {
        title: "URLs",
        rows: urls.map((url) => {
          const httpRest = url.startsWith("http://") ? url.slice("http://".length) : undefined;
          const muted = httpRest !== undefined && httpsRests.has(httpRest);
          return {
            label: url,
            ...(isWebUrl(url) ? { href: url } : {}),
            ...(muted ? { muted: true } : {}),
          };
        }),
        ...(urls.length === 0 ? { notes: ["No published endpoints."] } : {}),
      },
      {
        title: "Services",
        rows,
        ...(rows.length === 0 ? { notes: ["No services were started."] } : {}),
      },
    ],
    nextSteps: ["lando info", "lando logs", "lando exec <service> -- <command>"],
    footer:
      restarting === 0
        ? `${total} ${noun} ready`
        : `${ready} ${serviceNoun(ready)} ready; ${restarting} restarting`,
  };
};

const renderPlainStartAppResult = (result: StartAppResult): string => {
  const services = serviceRowsText(result.servicesStarted);
  return lifecycleLine("ready", result.app, services);
};

export const renderStartAppResult = (result: StartAppResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx))
    return `\n${formatQuietSummary(buildStartSummary(result), summaryPaintOptions(ctx))}`;
  return renderPlainStartAppResult(result);
};
