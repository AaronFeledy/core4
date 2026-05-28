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
    expect(plan.command).toEqual([
      "sh",
      "-c",
      [
        "cat > /etc/nginx/conf.d/default.conf <<'LANDO_STATIC_NGINX'",
        "server {",
        "  listen 80;",
        "  server_name _;",
        '  root "/app";',
        "  index index.html index.htm;",
        "  location / { try_files $uri $uri/ =404; }",
        "}",
        "LANDO_STATIC_NGINX",
        "exec nginx -g 'daemon off;'",
      ].join("\n"),
    ]);
    expect(plan.endpoints[0]?.port).toBe(80);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 80"]);
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
    expect(plan.command).toEqual(["caddy", "file-server", "--listen", ":80", "--root", "/app"]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 80"]);
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "caddy" });
  });

  test("root: dist sets LANDO_WEBROOT to /app/dist and records root in extensions", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "static", root: "dist" } },
    });
    const service = landofile.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");

    const plan = staticNginxServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.environment.LANDO_WEBROOT).toBe("/app/dist");
    expect(plan.command).toEqual(["sh", "-c", expect.stringContaining('root "/app/dist";')]);
    expect(plan.appMount?.readOnly).toBe(true);
    expect(plan.endpoints[0]?.port).toBe(80);
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "nginx", root: "dist" });
  });

  test("root: '/' or empty string falls back to /app without trailing slash", () => {
    for (const rootValue of ["", "/", "///", "/dist/", "dist/"] as const) {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: { web: { type: "static", root: rootValue } },
      });
      const service = landofile.services?.[ServiceName.make("web")];
      if (service === undefined) throw new Error("web service missing");

      const plan = staticNginxServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      });

      const expectedWebroot = rootValue.replace(/^\/+/, "").replace(/\/+$/, "") === "" ? "/app" : "/app/dist";
      expect(plan.environment.LANDO_WEBROOT).toBe(expectedWebroot);
      expect(plan.command).toEqual(["sh", "-c", expect.stringContaining(`root "${expectedWebroot}";`)]);
      expect(plan.extensions["lando-service-static"]).toEqual({ server: "nginx", root: rootValue });
    }
  });

  test("custom static commands are preserved", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "static", command: ["custom-static-server"], entrypoint: ["/bin/sh", "-c"] } },
    });
    const service = landofile.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");

    const plan = staticNginxServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.command).toEqual(["custom-static-server"]);
    expect(plan.entrypoint).toEqual(["/bin/sh", "-c"]);
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
