/** `lando start` result rendering. */
import type { StartAppResult } from "@lando/sdk/app";

import {
  type SummaryDocument,
  type SummaryTone,
  formatQuietSummary,
  worstSummaryTone,
} from "@lando/renderer/summary";
import type { RenderContext } from "../renderer-boundary";
import { isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";

const READY_STATES = new Set(["running", "ready"]);

const isReadyState = (state: string): boolean => READY_STATES.has(state);

const isStartAppReady = (result: StartAppResult): boolean =>
  result.servicesStarted.length > 0 && result.servicesStarted.every((service) => isReadyState(service.state));

const startStatusTone = (state: string): SummaryTone => {
  switch (state) {
    case "running":
    case "ready":
      return "ok";
    case "starting":
      return "pending";
    case "stopped":
      return "skipped";
    case "unhealthy":
    case "error":
    case "failed":
      return "error";
    default:
      return "warn";
  }
};

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

const endpointText = (endpoints: ReadonlyArray<string>): string =>
  endpoints.length === 0 ? "no endpoints" : endpoints.join(", ");

const serviceNoun = (count: number): string => (count === 1 ? "service" : "services");

export const buildStartSummary = (result: StartAppResult): SummaryDocument => {
  const urls = uniqueEndpoints(result.servicesStarted);
  const httpsRests = new Set(
    urls.flatMap((url) => (url.startsWith("https://") ? [url.slice("https://".length)] : [])),
  );
  const rows = result.servicesStarted.map((service) => ({
    label: service.name,
    tone: startStatusTone(service.state),
    value: service.state,
  }));
  const readyCount = result.servicesStarted.filter((service) => isReadyState(service.state)).length;
  const total = result.servicesStarted.length;
  const ready = isStartAppReady(result);
  const noun = serviceNoun(total);
  return {
    title: ready ? "Started" : "Not fully ready",
    tone: ready ? "ok" : worstSummaryTone(rows.map((row) => row.tone)),
    subtitle: ready ? `${result.app} is ready` : `${result.app} is not fully ready`,
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
    nextSteps: ready ? ["lando info", "lando logs", "lando exec -- <cmd>"] : ["lando info", "lando logs"],
    footer: ready ? `${total} ${noun} ready` : `${readyCount} of ${total} ${noun} ready`,
  };
};

const renderPlainStartAppResult = (result: StartAppResult): string => {
  const services = result.servicesStarted
    .map((service) => `${service.name} (${service.state}) ${endpointText(service.endpoints)}`)
    .join("; ");
  const prefix = isStartAppReady(result) ? "ready" : "starting";
  return `${prefix}: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};

export const renderStartAppResult = (result: StartAppResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx))
    return `\n${formatQuietSummary(buildStartSummary(result), summaryPaintOptions(ctx))}`;
  return renderPlainStartAppResult(result);
};
