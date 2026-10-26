import { activeHostHttpUrls } from "@lando/engine/operations/service-connections";
/** `lando start` result rendering. */
import type { StartAppResult } from "@lando/sdk/app";
import type { CheckResult, ServiceConnection } from "@lando/sdk/schema";

import { type SummaryDocument, formatQuietSummary, worstSummaryTone } from "@lando/renderer/summary";
import type { RenderContext } from "../renderer-boundary";
import { isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import { connectionText, scopedConnectionText } from "./connection-summary";
import { START_STATUS_TONES, lifecycleLine, serviceRowsText, summaryToneFromTable } from "./service-summary";

export const startStatusTone = summaryToneFromTable(START_STATUS_TONES, "warn");

const uniqueEndpoints = (services: StartAppResult["servicesStarted"]): readonly ServiceConnection[] => {
  const seen = new Set<string>();
  const https: ServiceConnection[] = [];
  const http: ServiceConnection[] = [];
  const other: ServiceConnection[] = [];
  for (const service of services) {
    for (const connection of service.connections.filter((connection) => connection.scope === "host")) {
      const text = connectionText(connection);
      if (seen.has(text)) continue;
      seen.add(text);
      if (connection.protocol === "https") https.push(connection);
      else if (connection.protocol === "http") http.push(connection);
      else other.push(connection);
    }
  }
  return [...https, ...http, ...other];
};

const isWebUrl = (url: string): boolean => url.startsWith("https://") || url.startsWith("http://");

const endpointPrefix = (url: string): string => new URL(url.endsWith("/") ? url : `${url}/`).href;

// A check probes its endpoint plus the service's scan path, so a check URL can
// also start with a shorter sibling route (`/api` vs `/api/v2`). The endpoint
// that owns a check is the longest published URL of its service that prefixes it.
const checkEndpoint = (result: StartAppResult, check: CheckResult): string | undefined =>
  activeHostHttpUrls(
    result.servicesStarted.find((service) => service.name === check.service)?.connections ?? [],
  )
    .filter((endpoint) => check.url.startsWith(endpointPrefix(endpoint)))
    .reduce<string | undefined>(
      (longest, endpoint) => (longest === undefined || endpoint.length > longest.length ? endpoint : longest),
      undefined,
    );

const serviceNoun = (count: number): string => (count === 1 ? "service" : "services");

/** Readiness verdict shared by the start, rebuild, and restart summaries. */
export const startOutcome = (
  result: Pick<StartAppResult, "app" | "servicesStarted">,
): Pick<SummaryDocument, "tone" | "subtitle" | "nextCommands" | "footer"> => {
  const ready = result.servicesStarted.filter((service) =>
    ["running", "healthy", "ready"].includes(service.state),
  ).length;
  const completed = result.servicesStarted.filter((service) => service.state === "completed").length;
  const remaining = result.servicesStarted.filter(
    (service) => !["running", "healthy", "ready", "completed"].includes(service.state),
  );
  const stateCounts = new Map<string, number>();
  for (const service of remaining) stateCounts.set(service.state, (stateCounts.get(service.state) ?? 0) + 1);
  return {
    tone:
      result.servicesStarted.length === 0
        ? "info"
        : worstSummaryTone([
            ...result.servicesStarted.map((service) => startStatusTone(service.state)),
            ...(remaining.length === 0 ? [] : ["warn" as const]),
          ]),
    subtitle:
      remaining.length === 0 ? `${result.app} is ready` : `${result.app} has services that are not ready`,
    nextCommands: ["info", "logs", "exec"],
    footer: [
      `${ready} ${serviceNoun(ready)} ready`,
      ...(completed === 0 ? [] : [`${completed} completed`]),
      ...Array.from(stateCounts, ([state, count]) => `${count} ${state}`),
    ].join("; "),
  };
};

export const buildStartSummary = (
  result: StartAppResult,
  action: "start" | "rebuild" = "start",
): SummaryDocument => {
  const urls = uniqueEndpoints(result.servicesStarted);
  const httpsRests = new Set(
    urls.flatMap((connection) =>
      connection.binding === "assigned" &&
      connection.state === "active" &&
      connection.url.startsWith("https://")
        ? [connection.url.slice("https://".length)]
        : [],
    ),
  );
  // Host URLs are listed once above; the app-network address is per service,
  // so a database moved to an unpublished port still shows where to dial it.
  const rows = result.servicesStarted.map((service) => ({
    label: service.name,
    tone: startStatusTone(service.state),
    value: service.state,
    ...(scopedConnectionText(service.connections, "app").length === 0
      ? {}
      : { fields: [{ label: "App Network", value: scopedConnectionText(service.connections, "app") }] }),
  }));
  return {
    title: action === "rebuild" ? "Rebuilt" : "Started",
    ...startOutcome(result),
    sections: [
      {
        title: "Host",
        rows: urls.map((connection) => {
          const url = connection.url ?? "";
          const link = activeHostHttpUrls([connection])[0];
          const httpRest = url.startsWith("http://") ? url.slice("http://".length) : undefined;
          const muted = connection.state === "active" && httpRest !== undefined && httpsRests.has(httpRest);
          const check =
            link !== undefined && isWebUrl(url)
              ? result.checks?.find((check) => checkEndpoint(result, check) === url)
              : undefined;
          let suffix = "";
          if (check !== undefined) {
            switch (check.verdict) {
              case "ready":
                suffix = check.statusCode === undefined ? "" : ` ${check.statusCode}`;
                break;
              case "app-error":
                suffix = ` ${check.statusCode} from your app`;
                break;
              case "service-error":
                suffix = ` ${check.statusCode} from the web server`;
                break;
              case "lando-error":
                suffix = " unreachable";
                break;
              default: {
                const unreachable: never = check.verdict;
                return unreachable;
              }
            }
          }
          return {
            label: `${connectionText(connection)}${suffix}`,
            ...(link === undefined ? {} : { href: link }),
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
  };
};

const renderPlainStartAppResult = (result: StartAppResult): string => {
  const services = serviceRowsText(result.servicesStarted);
  const ready = result.servicesStarted.every((service) =>
    ["running", "healthy", "ready", "completed"].includes(service.state),
  );
  return lifecycleLine(ready ? "ready" : "started", result.app, services);
};

export const renderStartAppResult = (result: StartAppResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx))
    return `\n${formatQuietSummary(buildStartSummary(result), summaryPaintOptions(ctx))}`;
  return renderPlainStartAppResult(result);
};
