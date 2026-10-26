import { activeHostHttpUrls } from "@lando/engine/operations/service-connections";
import type { SummaryField } from "@lando/renderer/summary";
import type { ServiceConnection } from "@lando/sdk/schema";

export const connectionText = (connection: ServiceConnection): string => {
  switch (connection.binding) {
    case "assigned": {
      const addresses = [connection.url, ...connection.alternateUrls].join(", ");
      return connection.state === "active" ? addresses : `${addresses} [${connection.state}]`;
    }
    case "pending":
      return `${connection.host}${connection.source === "route" ? connection.pathPrefix : ""} → ${connection.endpoint.port}/${connection.endpoint.transport} [pending · not published; ${connection.state}]`;
    default: {
      const unreachable: never = connection;
      return unreachable;
    }
  }
};

export const scopedConnectionText = (
  connections: readonly ServiceConnection[],
  scope: ServiceConnection["scope"],
): string =>
  connections
    .filter((connection) => connection.scope === scope)
    .map(connectionText)
    .join(", ");

export const connectionFields = (connections: readonly ServiceConnection[]): readonly SummaryField[] => [
  { label: "Host", value: scopedConnectionText(connections, "host") || "not published" },
  { label: "App Network", value: scopedConnectionText(connections, "app") || "-" },
];

/** Text linking must not also decorate an identical inactive or app-network URI. */
export const unambiguousHostHttpUrls = (connections: readonly ServiceConnection[]): readonly string[] => {
  const excluded = new Set(
    connections.flatMap((connection) => {
      switch (connection.binding) {
        case "pending":
          return [];
        case "assigned":
          return connection.scope === "app" || connection.state !== "active"
            ? [connection.url, ...connection.alternateUrls]
            : [];
        default: {
          const unreachable: never = connection;
          return unreachable;
        }
      }
    }),
  );
  return activeHostHttpUrls(connections).filter((url) => !excluded.has(url));
};
