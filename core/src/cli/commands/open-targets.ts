import type { AppPlan, StartedService } from "@lando/sdk/schema";
import { selectHttpEndpoint } from "@lando/sdk/schema";
import { Schema } from "effect";

export const OpenTargetSchema = Schema.Struct({
  service: Schema.String,
  hostname: Schema.String,
  scheme: Schema.Literals(["http", "https"]),
  url: Schema.String,
});
export type OpenTarget = typeof OpenTargetSchema.Type;

export interface OpenTargetSelection {
  readonly service?: string;
  readonly route?: string;
  readonly all?: boolean;
}

const preferHttps = (targets: readonly OpenTarget[]): readonly OpenTarget[] => {
  const target = targets.find((target) => target.scheme === "https") ?? targets[0];
  return target === undefined ? [] : [target];
};

export const resolveOpenTargets = (
  plan: Pick<AppPlan, "services">,
  selection: OpenTargetSelection,
  rows: readonly StartedService[],
): readonly OpenTarget[] => {
  const candidates = rows.flatMap((row) =>
    row.connections.flatMap((connection) => {
      if (
        connection.scope !== "host" ||
        connection.binding !== "assigned" ||
        connection.state !== "active" ||
        connection.host.includes("*") ||
        (connection.protocol !== "http" && connection.protocol !== "https")
      )
        return [];
      return [
        {
          source: connection.source,
          endpoint: connection.endpoint,
          target: {
            service: row.name,
            hostname: connection.host,
            scheme: connection.protocol,
            url: connection.url,
          } satisfies OpenTarget,
        },
      ];
    }),
  );
  if (selection.route !== undefined) {
    return preferHttps(
      candidates
        .filter(({ source, target }) => source === "route" && target.hostname === selection.route)
        .map(({ target }) => target),
    );
  }
  const listeners = new Map(
    Object.values(plan.services).map((service) => [
      String(service.name),
      selectHttpEndpoint(service.endpoints),
    ]),
  );
  const scoped = candidates.filter(({ target, endpoint }) => {
    if (selection.service !== undefined && target.service !== selection.service) return false;
    if (selection.all === true) return true;
    const listener = listeners.get(target.service);
    if (listener === undefined) return false;
    switch (listener.status) {
      case "selected":
        return endpoint.port === listener.endpoint.port && endpoint.transport === listener.endpoint.transport;
      case "none":
      case "ambiguous":
        return false;
      default: {
        const unreachable: never = listener;
        return unreachable;
      }
    }
  });
  const routes = scoped.filter(({ source }) => source === "route");
  const targets = (routes.length > 0 ? routes : scoped).map(({ target }) => target);
  // HTTP and HTTPS observations of the same route remain one --all target.
  const distinct =
    routes.length === 0
      ? targets
      : targets.filter(
          (target) =>
            target.scheme === "https" ||
            !targets.some(
              (other) =>
                other.scheme === "https" &&
                other.service === target.service &&
                other.hostname === target.hostname &&
                new URL(other.url).pathname === new URL(target.url).pathname,
            ),
        );
  if (selection.all === true) return distinct;
  for (const service of Object.values(plan.services)) {
    const selected = preferHttps(distinct.filter((target) => target.service === service.name));
    if (selected.length > 0) return selected;
  }
  return [];
};
