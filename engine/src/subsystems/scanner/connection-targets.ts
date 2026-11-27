import type { ServiceName, ServicePlan, StartedService } from "@lando/sdk/schema";

export type ScanSourceService = Pick<StartedService, "connections" | "routes"> & {
  readonly service: ServiceName;
  readonly servicePlan?: ServicePlan | undefined;
};

export const appendScanPath = (base: string, path: string): string => {
  const origin = base.endsWith("/") ? base : `${base}/`;
  const relative = path === "/" ? "" : path.replace(/^\//u, "");
  return new URL(relative, origin).toString();
};

export const publishedHostPorts = (source: ScanSourceService): readonly number[] =>
  source.connections.flatMap((connection) =>
    connection.scope === "host" && connection.binding === "assigned" && connection.state === "active"
      ? [connection.port]
      : [],
  );
