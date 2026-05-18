import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { staticCaddyServiceType, staticNginxServiceType } from "../src/services/static.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

describe("static ServiceType", () => {
  test("default nginx-backed static server uses read-only app mount", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "static" } },
    });
    const service = landofile.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");

    const plan = staticNginxServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.type).toBe("static:nginx");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "nginx:1.26-alpine" });
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("static:nginx");
    expect(plan.appMount?.readOnly).toBe(true);
    expect(plan.mounts[0]?.readOnly).toBe(true);
    expect(plan.endpoints[0]?.port).toBe(80);
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "nginx" });
  });

  test("caddy-backed static server picks caddy image", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "static:caddy" } },
    });
    const service = landofile.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");

    const plan = staticCaddyServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.type).toBe("static:caddy");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "caddy:2-alpine" });
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "caddy" });
  });

  test("rejects unsupported static server with remediation", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "static:lighttpd" } },
    });
    const service = landofile.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");

    expect(() =>
      staticNginxServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      }),
    ).toThrow(/Unsupported static server "lighttpd"\..*Set type to one of: static:nginx, static:caddy/);
  });
});
