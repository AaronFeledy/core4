import { expect, test } from "bun:test";
import { type RoutePlan, type ServiceState, StartedService } from "@lando/sdk/schema";
import { Schema } from "effect";
import { projectServiceConnections } from "../../src/operations/service-connections.ts";
import { projectServiceRoutes } from "../../src/operations/service-routes.ts";
import { web } from "./start-progress-topology-support.ts";

const route = {
  hostname: "web.test",
  priority: 2,
  scheme: "https",
  service: web.name,
  backend: { service: web.name, protocol: "http", port: 3000 },
} satisfies RoutePlan;

test.each(["stopped", "completed", "paused", "error"] satisfies ServiceState[])(
  "retains configured addresses as inactive when final state is %s",
  (state) => {
    const service = {
      ...web,
      endpoints: [{ kind: "published", protocol: "http", port: 3000, publication: { hostPort: 8080 } }],
    } satisfies typeof web;
    const row = {
      name: String(web.name),
      state,
      connections: projectServiceConnections({
        plan: { slug: "test" },
        service,
        state,
        publications: {
          status: "present",
          bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 }],
        },
      }),
      routes: projectServiceRoutes({
        service,
        state,
        routes: [route],
        routeEvidence: {
          configuredAuthorities: [{ hostname: "web.test", scheme: "https", port: 443 }],
          observation: { status: "unknown" },
        },
      }),
    };
    expect(Schema.encodeSync(StartedService)(row)).toEqual(row);
    expect(row.connections).toMatchObject([
      { source: "listener", state: "inactive", url: "http://web:3000" },
      { source: "publication", state: "inactive", url: "http://localhost:8080" },
    ]);
    expect(row.routes).toMatchObject([{ hostMatch: "exact", state: "inactive", url: "https://web.test" }]);
  },
);
