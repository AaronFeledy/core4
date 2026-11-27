import { connectionAuthority, effectiveRoutePath } from "@lando/engine/operations/connection-url";
import { activeHostHttpUrls } from "@lando/engine/operations/service-connections";
import {
  type SummaryDocument,
  type SummaryRow,
  formatQuietSummary,
  worstSummaryTone,
} from "@lando/renderer/summary";
/** `lando start` result rendering. */
import type { StartAppResult } from "@lando/sdk/app";
import type { CheckResult, ServiceConnection, ServiceRoute, StartedService } from "@lando/sdk/schema";
import type { RenderContext } from "../renderer-boundary";
import { isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import { appNetworkText, connectionText, routeText } from "./connection-summary";
import { START_STATUS_TONES, lifecycleLine, serviceRowsText, summaryToneFromTable } from "./service-summary";

export const startStatusTone = summaryToneFromTable(START_STATUS_TONES, "warn");

type Endpoint = ServiceConnection | ServiceRoute;

const endpointText = (endpoint: Endpoint): string =>
  "hostMatch" in endpoint ? routeText(endpoint) : connectionText(endpoint);

const twinAuthority = (endpoint: Extract<Endpoint, { binding: "assigned" }>): string =>
  connectionAuthority({
    ...endpoint,
    pathPrefix: effectiveRoutePath("hostMatch" in endpoint ? endpoint.pathPrefix : ""),
  });

const uniqueEndpoints = (endpoints: readonly Endpoint[]): readonly Endpoint[] => {
  const seen = new Set<string>();
  const https: Endpoint[] = [];
  const http: Endpoint[] = [];
  const other: Endpoint[] = [];
  for (const endpoint of endpoints) {
    const text = endpointText(endpoint);
    if (seen.has(text)) continue;
    seen.add(text);
    if (endpoint.protocol === "https") https.push(endpoint);
    else if (endpoint.protocol === "http") http.push(endpoint);
    else other.push(endpoint);
  }
  return [...https, ...http, ...other];
};

// A check probes its endpoint plus the service's scan path, so a check URL can
// also start with a shorter sibling route (`/api` vs `/api/v2`). The endpoint
// that owns a check is the longest published URL of its service that prefixes it.
const checkEndpoint = (service: StartedService, check: CheckResult): string | undefined =>
  activeHostHttpUrls(service)
    .filter((endpoint) => {
      const prefix = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
      return check.url === endpoint || check.url.startsWith(URL.parse(prefix)?.href ?? prefix);
    })
    .reduce<string | undefined>(
      (longest, endpoint) => (longest === undefined || endpoint.length > longest.length ? endpoint : longest),
      undefined,
    );

const checkSuffix = (check: CheckResult): string => {
  const redirect = check.statusCode !== undefined && check.statusCode >= 300 && check.statusCode < 400;
  switch (check.verdict) {
    case "ready":
      return check.statusCode === undefined ? "" : ` ${check.detail ?? check.statusCode}`;
    case "expected":
      return ` · expected${check.detail === undefined ? "" : `: ${check.detail}`}`;
    case "app-error":
      return redirect && check.detail !== undefined
        ? ` · ${check.detail}`
        : ` ${check.statusCode} from your app`;
    case "service-error":
      return ` ${check.statusCode} from the web server`;
    case "lando-error":
      return " unreachable";
    default: {
      const unreachable: never = check.verdict;
      return unreachable;
    }
  }
};

const endpointRows = (
  endpoints: readonly Endpoint[],
  checks: ReadonlyMap<string, readonly CheckResult[]>,
): readonly SummaryRow[] => {
  const httpsAuthorities = new Set(
    endpoints.flatMap((row) =>
      row.binding === "assigned" && row.state === "active" && row.protocol === "https"
        ? [twinAuthority(row)]
        : [],
    ),
  );
  const withChecks = new Set<string>();
  return endpoints.map((row) => {
    const [link] = activeHostHttpUrls(
      "hostMatch" in row ? { routes: [row], connections: [] } : { connections: [row], routes: [] },
    );
    const muted =
      row.binding === "assigned" &&
      row.state === "active" &&
      row.protocol === "http" &&
      httpsAuthorities.has(twinAuthority(row));
    const suffix =
      link === undefined || withChecks.has(link) ? "" : (checks.get(link) ?? []).map(checkSuffix).join("");
    if (link !== undefined) withChecks.add(link);
    return {
      label: `${endpointText(row)}${suffix}`,
      ...(link === undefined ? {} : { href: link }),
      ...(muted ? { muted: true } : {}),
    };
  });
};

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
  const routes = result.servicesStarted.flatMap((service) => service.routes);
  const urls = uniqueEndpoints([
    ...result.servicesStarted.flatMap((service) => service.connections.filter((row) => row.scope === "host")),
    ...routes.filter((route) => route.hostMatch === "exact"),
  ]);
  const patterns = uniqueEndpoints(routes.filter((route) => route.hostMatch === "pattern"));
  const checks = new Map<string, CheckResult[]>();
  for (const check of result.checks ?? []) {
    const service = result.servicesStarted.find((row) => row.name === check.service);
    const link = service === undefined ? undefined : checkEndpoint(service, check);
    if (link === undefined) continue;
    const attached = checks.get(link);
    if (attached === undefined) checks.set(link, [check]);
    else attached.push(check);
  }
  // Host URLs are listed once above; the app-network address is per service,
  // so a database moved to an unpublished port still shows where to dial it.
  const rows = result.servicesStarted.map((service) => {
    const app = appNetworkText(service);
    return {
      label: service.name,
      tone: startStatusTone(service.state),
      value: service.state,
      ...(app.length === 0 ? {} : { fields: [{ label: "App Network", value: app }] }),
    };
  });
  return {
    title: action === "rebuild" ? "Rebuilt" : "Started",
    ...startOutcome(result),
    sections: [
      ...(urls.length > 0 || patterns.length === 0
        ? [
            {
              title: "Host",
              rows: endpointRows(urls, checks),
              ...(urls.length === 0 ? { notes: ["No published endpoints."] } : {}),
            },
          ]
        : []),
      ...(patterns.length === 0 ? [] : [{ title: "Route patterns", rows: endpointRows(patterns, checks) }]),
      {
        title: "Services",
        rows,
        ...(rows.length === 0 ? { notes: ["No services were started."] } : {}),
      },
      ...(result.servicesStayedDown === undefined || result.servicesStayedDown.length === 0
        ? []
        : [
            {
              title: "Stayed down",
              rows: result.servicesStayedDown.map((name) => ({ label: name })),
              notes: ["Run `lando start` to start them."],
            },
          ]),
    ],
  };
};

export const expectedCheckMessages = (checks: readonly CheckResult[] = []): string[] =>
  checks.flatMap((check) =>
    check.verdict === "expected" ? [check.message ?? check.detail ?? `${check.url} · expected`] : [],
  );

const renderPlainStartAppResult = (result: StartAppResult): string => {
  const services = serviceRowsText(result.servicesStarted);
  const ready = result.servicesStarted.every((service) =>
    ["running", "healthy", "ready", "completed"].includes(service.state),
  );
  const started = lifecycleLine(ready ? "ready" : "started", result.app, services);
  const stayedDown = result.servicesStayedDown;
  const summary =
    stayedDown === undefined || stayedDown.length === 0
      ? started
      : `${started}; stayed down: ${stayedDown.join(", ")}`;
  return [summary, ...expectedCheckMessages(result.checks)].join("\n");
};

export const renderStartAppResult = (result: StartAppResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx))
    return `\n${formatQuietSummary(buildStartSummary(result), summaryPaintOptions(ctx))}`;
  return renderPlainStartAppResult(result);
};
