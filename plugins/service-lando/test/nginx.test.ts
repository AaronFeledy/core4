import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type {
  AppFeatureContext,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
} from "@lando/sdk/services";

import { LANDO_ERROR_PAGES_BUILD_STEP_ID } from "../src/services/http-errors.ts";
import {
  NGINX_FEATURE_ID,
  nginxPhpFpmWireFeature,
  nginxServiceFeature,
  nginxServiceType,
} from "../src/services/nginx.ts";
import { composeServicePlan } from "./support/compose-harness.ts";
import { expectSharedErrorPagesBuildStep } from "./support/error-pages.ts";
import { nginxNoScriptRegex } from "../src/services/nginx-no-scripts.ts";
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

const noScriptDeny = (glob: string): string =>
  `location ~* ^/${nginxNoScriptRegex(glob)}/.*\\.php(/|$) { deny all; }`;

const expectNoScriptDenyBeforePhp = (command: string, glob = "sites/*/files"): void => {
  const deny = noScriptDeny(glob);
  const phpLocation = "location ~ [^/]\\.php(/|$) {";
  expect(command).toContain(deny);
  expect(command.indexOf(deny)).toBeGreaterThan(-1);
  expect(command.indexOf(phpLocation)).toBeGreaterThan(command.indexOf(deny));
};

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
  test.each([undefined, "appserver"])(
    "rejects unsafe webroots during resolution with backend %s",
    async (backend) => {
      // Given: either standalone nginx or a PHP-FPM frontend with an unsafe root.
      for (const webroot of ["web root", "/app/$host"] as const) {
        // When / Then: resolution fails before either launcher can use the root.
        await expectRejectsToThrow(
          composeNginxPlan({ type: "nginx", webroot, ...(backend === undefined ? {} : { backend }) }),
          /nginx webroot must be a path relative to the app mount/,
        );
      }
    },
  );

  test.each([undefined, "appserver"])("accepts a safe absolute webroot with backend %s", async (backend) => {
    // Given / When: a valid root uses every supported punctuation character.
    const webroot = "/app/web-root_1.x";
    const plan = await composeNginxPlan({
      type: "nginx",
      webroot,
      ...(backend === undefined ? {} : { backend }),
    });

    // Then: both launchers and the environment preserve the authored path.
    expect(plan.environment.LANDO_WEBROOT).toBe(webroot);
    expect(planCommandText(plan.command)).toContain(
      backend === undefined ? `root "${webroot}";` : `root ${webroot};`,
    );
  });

  test("serves /app with the generated static launcher when no backend is authored", async () => {
    // Given / When: a standalone nginx service with default web settings.
    const plan = await composeNginxPlan({ type: "nginx" });

    // Then: the launcher owns the static site and its error-page assets.
    const command = planCommandText(plan.command);
    expect(command).toContain("listen 80;");
    expect(command).toContain('root "/app";');
    expect(command).toContain("index index.html index.htm;");
    expect(command).toContain("location / { try_files $uri $uri/ =404; }");
    expect(command).toContain("error_page 403 /_lando/errors/403.html;");
    expect(command).toContain("error_page 404 /_lando/errors/404.html;");
    expect(command).toContain("alias /usr/share/lando/errors/;");
    expect(command).toContain("include /etc/nginx/conf.d/*.conf;");
    expect(command).not.toContain("fastcgi_pass");
    expectSharedErrorPagesBuildStep(plan);
    expect(plan.extensions["@lando/core/service-features"]).toMatchObject({
      buildSteps: expect.arrayContaining([
        expect.objectContaining({ command: ["rm", "-f", "/etc/nginx/conf.d/default.conf"] }),
      ]),
    });
    expect(plan.dependsOn).toEqual([]);
  });

  test("serves the authored webroot when standalone", async () => {
    // Given / When: a standalone site under the public subdirectory.
    const plan = await composeNginxPlan({ type: "nginx", webroot: "public" });

    // Then: nginx serves that directory rather than the image's default root.
    expect(planCommandText(plan.command)).toContain('root "/app/public";');
    expect(plan.environment.LANDO_WEBROOT).toBe("/app/public");
  });

  test("moves the listener, endpoint, and healthcheck when port is authored", async () => {
    // Given / When: a standalone site listening on a non-default port.
    const plan = await composeNginxPlan({ type: "nginx", port: 8080 });

    // Then: all three port consumers agree.
    const command = planCommandText(plan.command);
    expect(command).toContain("listen 8080;");
    expect(command).not.toContain("listen 80;");
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 8080, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 8080"]);
  });

  test("omits the worker user directive when standalone runs as non-root", async () => {
    // Given / When: the image's nginx account owns the standalone process.
    const plan = await composeNginxPlan({ type: "nginx", user: "nginx", home: false, port: 8080 });

    // Then: the same writable launcher runs without a root-only directive.
    const command = planCommandText(plan.command);
    expect(plan.user).toBe("nginx");
    expect(command).toContain("nginx -c /tmp/lando-nginx.conf");
    expect(command).not.toContain("user nginx;");
  });

  test.each(["command", "entrypoint"] as const)(
    "opts out of the launcher when %s is authored",
    async (field) => {
      // Given / When: authored startup replaces Lando's standalone launcher.
      const authored = ["nginx", "-g", "daemon off;"];
      const plan = await composeNginxPlan({ type: "nginx", [field]: authored });

      // Then: image startup and its stock site remain the author's responsibility.
      expect(plan[field]).toEqual(authored);
      if (field === "entrypoint") expect(plan.command).toBeUndefined();
      expect(plan.extensions["@lando/core/service-features"]).not.toMatchObject({
        buildSteps: expect.arrayContaining([
          expect.objectContaining({ command: ["rm", "-f", "/etc/nginx/conf.d/default.conf"] }),
        ]),
      });
      expect(plan.extensions["@lando/core/service-features"]).not.toMatchObject({
        buildSteps: expect.arrayContaining([
          expect.objectContaining({ id: LANDO_ERROR_PAGES_BUILD_STEP_ID }),
        ]),
      });
    },
  );

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
    expect(plan.mounts).toEqual([]);
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
    expect(command).not.toContain("location ~* ^/");
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

  test("denies PHP under authored noScripts before the FastCGI location", async () => {
    const plan = await composeNginxPlan({
      type: "nginx",
      backend: "appserver",
      webroot: "/app/web",
      noScripts: ["sites/*/files", "uploads"],
    });

    const command = planCommandText(plan.command);
    expectNoScriptDenyBeforePhp(command, "sites/*/files");
    expectNoScriptDenyBeforePhp(command, "uploads");
    expectPhpFpmPathInfoWire(command);
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
    readonly noScripts?: ReadonlyArray<string>;
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
          ...(input.noScripts === undefined ? {} : { noScripts: input.noScripts }),
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
      viewOf({ serviceName: "edge", serviceType: "nginx", backend: "appserver", webroot: "web" }),
    ]);

    await Effect.runPromise(nginxPhpFpmWireFeature.apply(context));

    expect(commandText(commands.get("edge"))).toContain("fastcgi_pass appserver:9070");
    expect(commandText(commands.get("edge"))).toContain("root /app/web");
    expect(commandText(commands.get("edge"))).toContain("error_page 404 /_lando/errors/404.html;");
    expect(commandText(commands.get("edge"))).not.toContain("fastcgi_intercept_errors");
    expectPhpFpmPathInfoWire(commandText(commands.get("edge")));
    expect(commandText(commands.get("edge"))).not.toContain("location ~* ^/");
    expect(commands.get("appserver")).toBeUndefined();
  });

  test("wired FastCGI command denies authored noScripts before the PHP location", async () => {
    const { context, commands } = applyWire([
      viewOf({ serviceName: "appserver", serviceType: "php:8.3", via: "fpm", port: 9070 }),
      viewOf({
        serviceName: "edge",
        serviceType: "nginx",
        backend: "appserver",
        webroot: "web",
        noScripts: ["sites/*/files"],
      }),
    ]);

    await Effect.runPromise(nginxPhpFpmWireFeature.apply(context));

    const command = commandText(commands.get("edge"));
    expectNoScriptDenyBeforePhp(command);
    expectPhpFpmPathInfoWire(command);
  });

  test("wired FastCGI command does not invent noScripts from a Drupal framework", async () => {
    const { context, commands } = applyWire([
      viewOf({ serviceName: "appserver", serviceType: "php:8.3", via: "fpm" }),
      viewOf({ serviceName: "edge", serviceType: "nginx", backend: "appserver" }),
    ]);

    await Effect.runPromise(nginxPhpFpmWireFeature.apply(context));

    expect(commandText(commands.get("edge"))).not.toContain(noScriptDeny("sites/*/files"));
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

describe("nginx noScripts glob translation", () => {
  test("escapes dots and turns each * into one path segment", () => {
    expect(nginxNoScriptRegex("sites/*/files")).toBe("sites/[^/]+/files");
    expect(nginxNoScriptRegex("uploads")).toBe("uploads");
    expect(nginxNoScriptRegex("sites/default.files")).toBe("sites/default\\.files");
  });

  test("rejects an unsafe path instead of interpolating it", () => {
    expect(() => nginxNoScriptRegex("files; } location / {")).toThrow(
      /nginx noScripts path is not a safe webroot-relative URI/,
    );
    expect(() => nginxNoScriptRegex("sites/**/files")).toThrow(
      /nginx noScripts path is not a safe webroot-relative URI/,
    );
  });
});
