import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type {
  AppFeatureContext,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
} from "@lando/sdk/services";

import {
  NGINX_FEATURE_ID,
  nginxPhpFpmWireFeature,
  nginxServiceFeature,
  nginxServiceType,
} from "../src/services/nginx.ts";
import { composeServicePlan } from "./support/compose-harness.ts";
import { expectSharedErrorPagesBuildStep } from "./support/error-pages.ts";
import { expectPhpFpmPathInfoWire } from "./support/php-fpm-path-info-wire.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[NGINX_FEATURE_ID, nginxServiceFeature]]);

const decodeService = (raw: unknown, serviceName = "web"): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { [serviceName]: raw },
  });
  const service = landofile.services?.[ServiceName.make(serviceName)];
  if (service === undefined) throw new Error(`${serviceName} service missing`);
  return service;
};

const composeNginxPlan = (raw: unknown, serviceName = "web"): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType: nginxServiceType,
    service: decodeService(raw, serviceName),
    appRoot: APP_ROOT,
    appName: "myapp",
    serviceName,
    metadata,
    featureOverrides,
  });

const planCommandText = (command: ServicePlan["command"]): string =>
  Array.isArray(command) ? command.join(" ") : typeof command === "string" ? command : "";

const expectRejectsToThrow = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let rejected = false;
  await promise.then(
    () => undefined,
    (error: unknown) => {
      rejected = true;
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(pattern);
    },
  );
  expect(rejected).toBe(true);
};

describe("nginx ServiceType", () => {
  test("plans a default nginx web service with app bind mount", async () => {
    const plan = await composeNginxPlan({ type: "nginx" });

    expect(plan.type).toBe("nginx");
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
      LANDO_SERVICE_TYPE: "nginx",
      LANDO_WEBROOT: "/app",
    });
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBeUndefined();
    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);
    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");
    expect(plan.mounts[0]?.readOnly).toBe(false);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 80, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 80"]);
  });

  test("uses the authored service name in endpoint and lando env", async () => {
    const plan = await composeNginxPlan({ type: "nginx" }, "proxy");

    expect(plan.primary).toBe(false);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 80, protocol: "http", name: "proxy" }]);
    expect(plan.environment).toMatchObject({
      LANDO_SERVICE_NAME: "proxy",
      LANDO_SERVICE_TYPE: "nginx",
      LANDO_WEBROOT: "/app",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT_MOUNT: "/app",
    });
  });

  test("rejects LANDO_* env overrides", async () => {
    await expectRejectsToThrow(
      composeNginxPlan({ type: "nginx", environment: { LANDO_APP_NAME: "fake" } }),
      /reserved LANDO_\* keys.*LANDO_APP_NAME/,
    );
  });
});

describe("nginx PHP FastCGI preset", () => {
  test("fronts a named FPM backend on port 9000", async () => {
    const plan = await composeNginxPlan({
      type: "nginx",
      backend: "appserver",
      webroot: "/app/web",
    });

    const command = planCommandText(plan.command);
    expect(command).toContain("fastcgi_pass appserver:9000");
    expect(command).toContain("root /app/web");
    expectPhpFpmPathInfoWire(command);
    expectSharedErrorPagesBuildStep(plan);
    expect(command).toContain("alias /usr/share/lando/errors/;");
    expect(command).toContain("error_page 403 /_lando/errors/403.html;");
    expect(command).toContain("error_page 404 /_lando/errors/404.html;");
    expect(command).not.toContain("fastcgi_intercept_errors");
    expect(plan.dependsOn).toEqual([
      { service: ServiceName.make("appserver"), condition: "service_healthy", required: true },
    ]);
  });

  test("starts a non-root FastCGI front without writing into the image config tree", async () => {
    // Given / When: an identity the nginx image ships, with home persistence
    // declined so the planned user is the only thing under test.
    const plan = await composeNginxPlan({
      type: "nginx",
      backend: "appserver",
      webroot: "/app/web",
      user: "nginx",
      home: false,
    });

    // Then: the planned user reaches the container and the launcher writes only
    // where that user can write, pointing nginx at that file explicitly.
    expect(plan.user).toBe("nginx");
    expect(plan.command?.slice(0, 2)).toEqual(["sh", "-c"]);
    const script = String(plan.command?.[2] ?? "");
    expect(script).toContain("exec nginx -c /tmp/lando-nginx.conf -g 'daemon off;'");
    expect(script).toContain("pid /tmp/lando-nginx.pid;");
    expect(script).toContain("fastcgi_temp_path /tmp/lando-nginx-fastcgi;");
    expect(script).toContain("fastcgi_pass appserver:9000");
    expect(script).toContain("include /etc/nginx/fastcgi_params;");
    expectPhpFpmPathInfoWire(script);
    expect(script).not.toContain("/etc/nginx/conf.d/default.conf");
    expect(script).not.toContain("user nginx;");
    expect([...script.matchAll(/>\s*(\S+)/gu)].map((match) => match[1])).toEqual(["/tmp/lando-nginx.conf"]);
  });
});

describe("nginx PHP FPM app-feature wire", () => {
  const unusedMutators = {
    addEnv: () => undefined,
    addMount: () => undefined,
    setAppMount: () => undefined,
    addBuildStep: () => undefined,
    addStorage: () => undefined,
    addEndpoint: () => undefined,
    addDependency: () => undefined,
    addHostAlias: () => undefined,
    setHealthcheck: () => undefined,
    setCerts: () => undefined,
    setEntrypoint: () => undefined,
    setArtifact: () => undefined,
    setUser: () => undefined,
    setWorkingDirectory: () => undefined,
  } satisfies Omit<AppFeatureServiceMutators, "service" | "setCommand">;

  const viewOf = (input: {
    readonly serviceName: string;
    readonly serviceType: string;
    readonly backend?: string;
    readonly port?: number;
    readonly via?: string;
    readonly webroot?: string;
    readonly command?: ReadonlyArray<string>;
    readonly user?: string;
  }): AppFeatureServiceView => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        [input.serviceName]: {
          type: input.serviceType,
          ...(input.backend === undefined ? {} : { backend: input.backend }),
          ...(input.port === undefined ? {} : { port: input.port }),
          ...(input.via === undefined ? {} : { via: input.via }),
          ...(input.webroot === undefined ? {} : { webroot: input.webroot }),
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.user === undefined ? {} : { user: input.user, home: false }),
        },
      },
    });
    const service = landofile.services?.[ServiceName.make(input.serviceName)];
    if (service === undefined) throw new Error(`${input.serviceName} service missing`);
    return {
      serviceName: input.serviceName,
      serviceType: input.serviceType,
      base: "lando",
      primary: false,
      featureIds: [],
      normalizedConfig: service,
    };
  };

  const applyWire = (views: ReadonlyArray<AppFeatureServiceView>) => {
    const commands = new Map<string, ReadonlyArray<string> | string | undefined>();
    const mutatorsFor = (view: AppFeatureServiceView): AppFeatureServiceMutators => ({
      service: view,
      setCommand: (command) => {
        commands.set(view.serviceName, command);
      },
      ...unusedMutators,
    });
    const context: AppFeatureContext = {
      featureId: nginxPhpFpmWireFeature.id,
      appName: "myapp",
      appRoot: APP_ROOT,
      config: {},
      selected: views,
      forEachSelected: (mutate) => {
        for (const view of views) mutate(mutatorsFor(view));
      },
      select: (name) => {
        const view = views.find((candidate) => candidate.serviceName === name);
        return view === undefined ? undefined : mutatorsFor(view);
      },
    };
    return { context, commands };
  };

  const commandText = (command: ReadonlyArray<string> | string | undefined): string =>
    Array.isArray(command) ? command.join(" ") : typeof command === "string" ? command : "";

  test("FastCGI upstream uses the PHP FPM service's authored port", async () => {
    const { context, commands } = applyWire([
      viewOf({ serviceName: "appserver", serviceType: "php:8.3", via: "fpm", port: 9070 }),
      viewOf({ serviceName: "edge", serviceType: "nginx", backend: "appserver", webroot: "/app/web" }),
    ]);

    await Effect.runPromise(nginxPhpFpmWireFeature.apply(context));

    expect(commandText(commands.get("edge"))).toContain("fastcgi_pass appserver:9070");
    expect(commandText(commands.get("edge"))).toContain("root /app/web");
    expect(commandText(commands.get("edge"))).toContain("error_page 404 /_lando/errors/404.html;");
    expect(commandText(commands.get("edge"))).not.toContain("fastcgi_intercept_errors");
    expectPhpFpmPathInfoWire(commandText(commands.get("edge")));
    expect(commands.get("appserver")).toBeUndefined();
  });

  test("wired FastCGI command carries PATH_INFO after fastcgi_params and 404s a missing script file", async () => {
    const { context, commands } = applyWire([
      viewOf({ serviceName: "appserver", serviceType: "php:8.3", via: "fpm" }),
      viewOf({ serviceName: "edge", serviceType: "nginx", backend: "appserver" }),
    ]);

    await Effect.runPromise(nginxPhpFpmWireFeature.apply(context));

    // `/uploads/x.phar/y.php` matches the widened PHP location, then `!-f` 404s
    // because `y.php` is not a real file. The shared wire does not deny /uploads.
    expectPhpFpmPathInfoWire(commandText(commands.get("edge")));
  });

  test("FastCGI upstream stays on 9000 when the PHP FPM service omits port", async () => {
    const { context, commands } = applyWire([
      viewOf({ serviceName: "appserver", serviceType: "php:8.3", via: "fpm" }),
      viewOf({ serviceName: "edge", serviceType: "nginx", backend: "appserver" }),
    ]);

    await Effect.runPromise(nginxPhpFpmWireFeature.apply(context));

    expect(commandText(commands.get("edge"))).toContain("fastcgi_pass appserver:9000");
  });

  test("the wired FastCGI command honours the edge service's planned user", async () => {
    const { context, commands } = applyWire([
      viewOf({ serviceName: "appserver", serviceType: "php:8.3", via: "fpm", port: 9070 }),
      viewOf({ serviceName: "edge", serviceType: "nginx", backend: "appserver", user: "nginx" }),
    ]);

    await Effect.runPromise(nginxPhpFpmWireFeature.apply(context));

    const script = commandText(commands.get("edge"));
    expect(script).toContain("nginx -c /tmp/lando-nginx.conf");
    expect(script).not.toContain("user nginx;");
    expect(script).not.toContain("/etc/nginx/conf.d/default.conf");
  });

  test("does not rewrite when the backend is not via fpm", async () => {
    const { context, commands } = applyWire([
      viewOf({ serviceName: "appserver", serviceType: "php:8.3", via: "apache", port: 8080 }),
      viewOf({ serviceName: "edge", serviceType: "nginx", backend: "appserver" }),
    ]);

    await Effect.runPromise(nginxPhpFpmWireFeature.apply(context));

    expect(commands.get("edge")).toBeUndefined();
  });

  test("does not rewrite an authored nginx command", async () => {
    const { context, commands } = applyWire([
      viewOf({ serviceName: "appserver", serviceType: "php:8.3", via: "fpm", port: 9070 }),
      viewOf({
        serviceName: "edge",
        serviceType: "nginx",
        backend: "appserver",
        command: ["nginx", "-g", "daemon off;"],
      }),
    ]);

    await Effect.runPromise(nginxPhpFpmWireFeature.apply(context));

    expect(commands.get("edge")).toBeUndefined();
  });
});
