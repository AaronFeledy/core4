import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { nginxServiceType } from "../src/services/nginx.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

describe("nginx ServiceType", () => {
  test("plans a default nginx web service with app bind mount", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "nginx" } },
    });
    const service = landofile.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");

    const plan = nginxServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.type).toBe("nginx");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "nginx:1.26-alpine" });
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("nginx");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.endpoints).toEqual([{ port: 80, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 80"]);
  });

  test("rejects LANDO_* env overrides", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        web: { type: "nginx", environment: { LANDO_APP_NAME: "fake" } },
      },
    });
    const service = landofile.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");

    expect(() =>
      nginxServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      }),
    ).toThrow(/User environment cannot override reserved LANDO_\* keys/);
  });
});
