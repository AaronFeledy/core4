import type { AppPlan, EndpointPlan, EndpointRef, StartedService } from "@lando/sdk/schema";
import { routeListenerPreference, selectHttpEndpoint } from "@lando/sdk/schema";
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

/**
 * The listeners a service's default routes reach, chosen with the same rule the
 * planner binds routes with. An HTTP route prefers an HTTP listener; an HTTPS
 * route prefers an HTTPS listener only when the service holds a generated
 * certificate the router can verify. Without one both schemes reach the plain
 * primary or the single listener, so the union collapses to that listener.
 */
export const defaultHttpListeners = (
  endpoints: readonly EndpointPlan[],
  generatedCertificate: boolean,
): readonly EndpointRef[] => {
  const listeners = (["http", "https"] as const).flatMap((scheme) => {
    const listener = selectHttpEndpoint(
      endpoints,
      undefined,
      routeListenerPreference(scheme, generatedCertificate),
    );
    return listener.status === "selected" ? [listener.endpoint] : [];
  });
  return listeners.filter(
    (listener, index) =>
      listeners.findIndex(
        (other) => other.port === listener.port && other.transport === listener.transport,
      ) === index,
  );
};

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
      defaultHttpListeners(service.endpoints, service.certs !== undefined),
    ]),
  );
  const scoped = candidates.filter(({ target, endpoint }) => {
    if (selection.service !== undefined && target.service !== selection.service) return false;
    if (selection.all === true) return true;
    return (listeners.get(target.service) ?? []).some(
      (listener) => endpoint.port === listener.port && endpoint.transport === listener.transport,
    );
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
