import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import { ServiceTypeError } from "@lando/sdk/errors";
import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { Schema } from "effect";
import { tcpProbe } from "../src/services/_tcp-probe.ts";
import { CADDY_CONFIG_PATH, caddyLauncherCommand } from "../src/services/caddy-config.ts";
import { LANDO_ERROR_PAGES_BUILD_STEP_ID } from "../src/services/http-errors.ts";
import { NGINX_DEFAULT_SITE_BUILD_STEP_ID } from "../src/services/nginx-config.ts";
import {
  STATIC_FEATURE_ID,
  staticCaddyServiceType,
  staticNginxServiceType,
  staticServiceFeature,
} from "../src/services/static.ts";
import { composeServicePlan } from "./support/compose-harness.ts";
import { firstEndpointPort } from "./support/endpoint.ts";
import { expectSharedErrorPagesBuildStep } from "./support/error-pages.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[STATIC_FEATURE_ID, staticServiceFeature]]);

const decodeService = (raw: unknown, serviceName = "web"): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { [serviceName]: raw },
  });
  const service = landofile.services?.[ServiceName.make(serviceName)];
  if (service === undefined) throw new Error(`${serviceName} service missing`);
  return service;
};

const composeStaticPlan = (
  raw: unknown,
  serviceType: ServiceType = staticNginxServiceType,
  serviceName = "web",
): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
    service: decodeService(raw, serviceName),
    appRoot: APP_ROOT,
    appName: "myapp",
    serviceName,
    metadata,
    featureOverrides,
  });

/** Every shell redirect target in a generated launcher script. */
const redirectTargets = (script: string): ReadonlyArray<string> =>
  [...script.matchAll(/>\s*(\S+)/gu)].map((match) => match[1] ?? "");

interface PlannedBuildStep {
  readonly id?: string;
  readonly user?: string;
  readonly command: string | ReadonlyArray<string>;
}

const buildStepsOf = (plan: ServicePlan): ReadonlyArray<PlannedBuildStep> => {
  const features = plan.extensions["@lando/core/service-features"] as
    | { readonly buildSteps?: ReadonlyArray<PlannedBuildStep> }
    | undefined;
  return features?.buildSteps ?? [];
};

const buildStepIds = (plan: ServicePlan): ReadonlyArray<string> =>
  buildStepsOf(plan).map((step) => step.id ?? "");

/** The exact Caddyfile bytes the shared image build step writes. */
const caddyConfigFrom = (plan: ServicePlan): string => {
  const step = buildStepsOf(plan).find((candidate) => candidate.id === LANDO_ERROR_PAGES_BUILD_STEP_ID);
  if (step === undefined) throw new Error("Caddy plan is missing the shared image build step");
  const command = typeof step.command === "string" ? step.command : step.command.join("\n");
  const match = new RegExp(`printf '%s' '([A-Za-z0-9+/=]+)' \\| base64 -d > ${CADDY_CONFIG_PATH}`, "u").exec(
    command,
  );
  if (match?.[1] === undefined) throw new Error(`Caddyfile write not found in: ${command}`);
  return Buffer.from(match[1], "base64").toString("utf8");
};

const expectRejectsToThrow = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let rejected = false;
  await promise.then(
    () => undefined,
    (error: unknown) => {
      rejected = true;
      const message =
        error instanceof ServiceTypeError
          ? [error.message, ...(error.issues ?? []).map((issue) => issue.suggestion ?? "")].join(" ")
          : error instanceof Error
            ? error.message
            : String(error);
      expect(message).toMatch(pattern);
    },
  );
  expect(rejected).toBe(true);
};

describe("static ServiceType", () => {
  test("default nginx-backed static server uses read-only app mount", async () => {
    const plan = await composeStaticPlan({ type: "static" });

    expect(plan.type).toBe("static:nginx");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "nginx:1.26-alpine" });
    expect(plan.environment).toMatchObject({
      LANDO: "ON",
      LANDO_APP_NAME: "myapp",
      LANDO_APP_KIND: "user",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT: "myapp",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_API: "4",
      LANDO_SERVICE_NAME: "web",
      LANDO_SERVICE_TYPE: "static:nginx",
      LANDO_WEBROOT: "/app",
    });
    expect(String(serviceAppMount(plan)?.source)).toBe(APP_ROOT);
    expect(String(serviceAppMount(plan)?.target)).toBe("/app");
    expect(serviceAppMount(plan)?.readOnly).toBe(true);
    expect(
      plan.mounts.filter(
        (mount) => mount.type !== "volume" && (mount.type !== "bind" || mount.role !== "app"),
      ),
    ).toEqual([]);
    expect(plan.command).toEqual([
      "sh",
      "-c",
      expect.stringContaining(`cat > /tmp/lando-nginx.conf <<'LANDO_NGINX_CONF'`),
    ]);
    expect(plan.command).toEqual([
      "sh",
      "-c",
      expect.stringContaining(
        [
          "server {",
          "  listen 80;",
          "  server_name _;",
          '  root "/app";',
          "  index index.html index.htm;",
          "  error_page 403 /_lando/errors/403.html;",
          "  error_page 404 /_lando/errors/404.html;",
        ].join("\n"),
      ),
    ]);
    expect(plan.endpoints).toEqual([
      { kind: "internal", port: 80, protocol: "http", name: "web", primary: true },
    ]);
    expect(plan.command).toEqual([
      "sh",
      "-c",
      expect.stringContaining("exec nginx -c /tmp/lando-nginx.conf -g 'daemon off;'"),
    ]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck).toEqual(tcpProbe(80, 10));
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "nginx", webroot: "/app" });
  });

  test("uses the authored service name in endpoint and lando env", async () => {
    const plan = await composeStaticPlan({ type: "static" }, staticNginxServiceType, "assets");

    expect(plan.primary).toBe(false);
    expect(plan.endpoints).toEqual([
      { kind: "internal", port: 80, protocol: "http", name: "assets", primary: true },
    ]);
    expect(plan.environment).toMatchObject({
      LANDO_SERVICE_NAME: "assets",
      LANDO_SERVICE_TYPE: "static:nginx",
      LANDO_WEBROOT: "/app",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT_MOUNT: "/app",
    });
  });

  test("Lando-owned nginx serves branded 403 and 404 pages outside the read-only app mount", async () => {
    const plan = await composeStaticPlan({ type: "static" });

    const command = Array.isArray(plan.command) ? plan.command.join(" ") : String(plan.command ?? "");
    expect(command).toContain("absolute_redirect off;");
    expect(command).toContain("location ~ /\\.(?!well-known(?:/|$)) {\n    return 403;\n  }");
    expectSharedErrorPagesBuildStep(plan);
    expect(command).toContain("alias /usr/share/lando/errors/;");
    expect(command).toContain("error_page 403 /_lando/errors/403.html;");
    expect(command).toContain("error_page 404 /_lando/errors/404.html;");
    expect(command).toContain("internal;");
    expect(command).not.toContain("/app/.lando");
  });

  test("starts a non-root static nginx service without writing into the image config tree", async () => {
    // Given / When: an identity the nginx image ships, with home persistence
    // declined so the planned user is the only thing under test.
    const plan = await composeStaticPlan({ type: "static", user: "nginx", home: false });

    // Then: the planned user reaches the container and the launcher writes only
    // where that user can write, pointing nginx at that file explicitly.
    expect(plan.user).toBe("nginx");
    expect(plan.command?.slice(0, 2)).toEqual(["sh", "-c"]);
    const script = String(plan.command?.[2] ?? "");
    expect(script).toContain("exec nginx -c /tmp/lando-nginx.conf -g 'daemon off;'");
    expect(script).toContain("pid /tmp/lando-nginx.pid;");
    expect(script).toContain("client_body_temp_path /tmp/lando-nginx-client-body;");
    expect(script).toContain("fastcgi_temp_path /tmp/lando-nginx-fastcgi;");
    expect(script).not.toContain("/etc/nginx/conf.d/default.conf");
    expect(script).not.toContain("user nginx;");
    expect(redirectTargets(script)).toEqual(["/tmp/lando-nginx.conf"]);
    expectSharedErrorPagesBuildStep(plan);
  });

  test("a root static nginx service keeps the image worker identity and its drop-ins", async () => {
    const plan = await composeStaticPlan({ type: "static" });

    const script = String(plan.command?.[2] ?? "");
    expect(script).toContain("user nginx;");
    expect(script).toContain("worker_processes auto;");
    expect(script).toContain("events {");
    expect(script).toContain("include /etc/nginx/mime.types;");
    expect(script).toContain("include /etc/nginx/conf.d/*.conf;");
    expect(script).toContain("sendfile on;");
    expect(script).toContain("keepalive_timeout 65;");
    expect(buildStepIds(plan)).toContain(NGINX_DEFAULT_SITE_BUILD_STEP_ID);
  });

  test("an authored static command keeps the image own default site", async () => {
    const plan = await composeStaticPlan({ type: "static", command: ["custom-static-server"] });

    expect(buildStepIds(plan)).not.toContain(NGINX_DEFAULT_SITE_BUILD_STEP_ID);
  });

  test("caddy-backed static server bakes the generated Caddyfile into the derived image", async () => {
    const plan = await composeStaticPlan({ type: "static:caddy" }, staticCaddyServiceType);

    expect(plan.type).toBe("static:caddy");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "caddy:2-alpine" });
    expect(plan.environment).toMatchObject({
      LANDO_SERVICE_TYPE: "static:caddy",
      LANDO_WEBROOT: "/app",
    });
    expect(plan.command).toEqual(caddyLauncherCommand());
    expect(buildStepIds(plan)).toContain(LANDO_ERROR_PAGES_BUILD_STEP_ID);
    const config = caddyConfigFrom(plan);
    expect(config).toContain("admin off");
    expect(config).toContain("auto_https off");
    expect(config).toContain("http://:80 {");
    expect(config).toContain('root * "/app"');
    expect(config).toContain('root * "/usr/share/lando/errors"');
    expect(config).toContain("error @hidden 403");
    expect(config).not.toContain("file-server");
    expect(serviceAppMount(plan)?.readOnly).toBe(true);
    expect(
      plan.mounts.filter(
        (mount) => mount.type !== "volume" && (mount.type !== "bind" || mount.role !== "app"),
      ),
    ).toEqual([]);
    expect(plan.endpoints).toEqual([
      { kind: "internal", port: 80, protocol: "http", name: "web", primary: true },
    ]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck).toEqual(tcpProbe(80, 10));
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "caddy", webroot: "/app" });
  });

  test("absolute webroot sets the nginx document root and LANDO_WEBROOT", async () => {
    const plan = await composeStaticPlan({ type: "static", webroot: "/app/dist" });

    expect(plan.environment.LANDO_WEBROOT).toBe("/app/dist");
    expect(plan.command).toEqual(["sh", "-c", expect.stringContaining('root "/app/dist";')]);
    expect(serviceAppMount(plan)?.readOnly).toBe(true);
    expect(firstEndpointPort(plan)).toBe(80);
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "nginx", webroot: "/app/dist" });
  });

  test("absolute webroot is normalized before reaching the launcher", async () => {
    for (const [webroot, resolved] of [
      ["/", "/"],
      ["/app/dist/", "/app/dist"],
    ] as const) {
      const plan = await composeStaticPlan({ type: "static", webroot });

      expect(plan.environment.LANDO_WEBROOT).toBe(resolved);
      expect(plan.command).toEqual(["sh", "-c", expect.stringContaining(`root "${resolved}";`)]);
      expect(plan.extensions["lando-service-static"]).toEqual({ server: "nginx", webroot: resolved });
    }
  });

  test("caddy uses the authored absolute webroot", async () => {
    const plan = await composeStaticPlan(
      { type: "static:caddy", webroot: "/app/_site" },
      staticCaddyServiceType,
    );

    expect(plan.command).toEqual(caddyLauncherCommand());
    expect(caddyConfigFrom(plan)).toContain('root * "/app/_site"');
    expect(plan.environment.LANDO_WEBROOT).toBe("/app/_site");
    expect(plan.extensions["lando-service-static"]).toEqual({ server: "caddy", webroot: "/app/_site" });
  });

  test("caddy follows an authored port in the baked site address and probe", async () => {
    const plan = await composeStaticPlan({ type: "static:caddy", port: 8080 }, staticCaddyServiceType);

    expect(caddyConfigFrom(plan)).toContain("http://:8080 {");
    expect(plan.endpoints).toEqual([
      { kind: "internal", port: 8080, protocol: "http", name: "web", primary: true },
    ]);
    expect(plan.healthcheck).toEqual(tcpProbe(8080, 10));
  });

  test("caddy keeps its generated configuration with additive build steps", async () => {
    const plan = await composeStaticPlan(
      { type: "static:caddy", build: { artifact: ["echo extra > /tmp/extra"] } },
      staticCaddyServiceType,
    );

    expect(buildStepIds(plan)).toContain(LANDO_ERROR_PAGES_BUILD_STEP_ID);
    expect(caddyConfigFrom(plan)).toContain("http://:80 {");
    expect(plan.command).toEqual(caddyLauncherCommand());
  });

  test("caddy starts non-root from the baked read-only configuration", async () => {
    const plan = await composeStaticPlan(
      { type: "static:caddy", user: "1000", home: false },
      staticCaddyServiceType,
    );

    expect(plan.user).toBe("1000");
    expect(plan.command).toEqual(caddyLauncherCommand());
  });

  test.each([
    {
      label: "an authored command",
      config: { command: ["caddy", "file-server"] },
      owner: "launcher",
      command: ["caddy", "file-server"],
    },
    {
      label: "an authored entrypoint",
      config: { entrypoint: ["/bin/sh", "-c"] },
      owner: "image",
      command: undefined,
    },
    {
      label: "a pinned image",
      config: { image: "caddy:2.8-alpine" },
      owner: "image",
      command: undefined,
    },
    {
      label: "a replacement build",
      config: { build: { context: "." } },
      owner: "image",
      command: undefined,
    },
  ] as const)(
    "caddy leaves its own server configuration alone for $label",
    async ({ config, owner, command }) => {
      const plan = await composeStaticPlan({ type: "static:caddy", ...config }, staticCaddyServiceType);

      expect(buildStepIds(plan)).not.toContain(LANDO_ERROR_PAGES_BUILD_STEP_ID);
      expect(() => caddyConfigFrom(plan)).toThrow(/missing the shared image build step/u);
      expect(plan.command).toEqual(command);
      expect(plan.listenerAuthority?.owner).toBe(owner);
    },
  );

  test("rejects unsafe webroots during service-type resolution", async () => {
    for (const webroot of ["", "/app/my site", '/app/bad"quote'] as const) {
      await expectRejectsToThrow(
        composeStaticPlan({ type: "static", webroot }),
        /Static webroot must be a path relative to the app mount/,
      );
    }
  });

  test("rejects the removed root service key during strict Landofile decode", () => {
    expect(() =>
      Schema.decodeUnknownSync(LandofileShape)(
        { name: "myapp", services: { web: { type: "static", root: "dist" } } },
        { onExcessProperty: "error" },
      ),
    ).toThrow(/root/);
  });

  test("custom static commands are preserved", async () => {
    const plan = await composeStaticPlan({
      type: "static",
      command: ["custom-static-server"],
      entrypoint: ["/bin/sh", "-c"],
      dependsOn: ["database"],
    });

    expect(plan.command).toEqual(["custom-static-server"]);
    expect(String(plan.command)).not.toContain("/usr/share/lando/errors");
    expect(plan.entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(plan.dependsOn).toEqual([]);
  });

  test("rejects unsupported static server with remediation", async () => {
    await expectRejectsToThrow(
      composeStaticPlan({ type: "static:lighttpd" }),
      /Unsupported static server "lighttpd"\..*Set type to one of: static:nginx, static:caddy/,
    );
  });
});

import { serviceAppMount } from "@lando/sdk/schema";
