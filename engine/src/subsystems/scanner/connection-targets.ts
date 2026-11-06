import type { ServiceConnection, ServiceName, ServicePlan } from "@lando/sdk/schema";
import { activeHostHttpUrls } from "../../operations/service-connections.ts";

export type ScanSourceEndpoint = ServiceConnection & {
  readonly service: ServiceName;
  readonly servicePlan?: ServicePlan | undefined;
};

export const appendScanPath = (base: string, path: string): string => {
  const origin = base.endsWith("/") ? base : `${base}/`;
  const relative = path === "/" ? "" : path.replace(/^\//u, "");
  return new URL(relative, origin).toString();
};

export const publishedHostPort = (connection: ScanSourceEndpoint): number | undefined =>
  connection.scope === "host" &&
  connection.source === "publication" &&
  connection.binding === "assigned" &&
  connection.state === "active"
    ? connection.port
    : undefined;

export const scanTargets = (connections: readonly ScanSourceEndpoint[], path: string) => {
  const targets = connections.flatMap((connection) =>
    activeHostHttpUrls([connection]).map((base) => ({
      service: connection.service,
      url: appendScanPath(base, path),
      endpoint: connection.endpoint,
    })),
  );
  return [...new Map(targets.map((target) => [`${target.service}/${target.url}`, target])).values()];
};
