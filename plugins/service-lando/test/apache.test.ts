import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { apacheServiceType } from "../src/services/apache.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

describe("apache ServiceType", () => {
  test("plans a default Apache web service with APACHE_DOCUMENT_ROOT env", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "apache" } },
    });
    const service = landofile.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");

    const plan = apacheServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.type).toBe("apache");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "httpd:2.4-alpine" });
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("apache");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app");
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.endpoints).toEqual([{ port: 80, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 80"]);
  });
});
