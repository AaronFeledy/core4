import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import { APACHE_LISTEN_BUILD_STEP_ID } from "../src/services/apache.ts";
import { LANDO_ERROR_PAGES_BUILD_STEP_ID, apacheErrorPageDirectives } from "../src/services/http-errors.ts";
import { APACHE_DEFAULT_SITE_BUILD_STEP_ID } from "../src/services/php-via.ts";
import {
  PHP_FEATURE_ID,
  SUPPORTED_PHP_VERSIONS,
  php82ServiceType,
  php83ServiceType,
  php85ServiceType,
  php86ServiceType,
  phpServiceFeature,
} from "../src/services/php.ts";
import { apacheLauncherDirectives } from "./support/apache-directives.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-17T22:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[PHP_FEATURE_ID, phpServiceFeature]]);

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const composePhpPlan = (serviceType: ServiceType, raw: unknown, appRoot = APP_ROOT): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
    service: decodeService(raw),
    appRoot,
    appName: "myapp",
    serviceName: "web",
    metadata,
    featureOverrides,
  });

interface PlannedBuildStep {
  readonly id?: string;
  readonly user?: string;
  readonly command: string | ReadonlyArray<string>;
}

const buildStepsFor = (plan: ServicePlan): ReadonlyArray<PlannedBuildStep> => {
  const features = plan.extensions["@lando/core/service-features"] as
    | { readonly buildSteps?: ReadonlyArray<PlannedBuildStep> }
    | undefined;
  return features?.buildSteps ?? [];
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

describe("php ServiceType — supported versions and frameworks", () => {
  test("exposes the complete PHP version catalog", () => {
    expect([...SUPPORTED_PHP_VERSIONS]).toEqual(["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"]);
  });
});

describe("php:8.2 ServiceType", () => {
  test("plans a default PHP 8.2 web service with framework=none defaults", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2" });

    expect(plan.type).toBe("php:8.2");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.2-apache-bookworm" });
    expect(plan.primary).toBe(true);
    expect(String(plan.workingDirectory)).toBe("/app");

    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);

    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 80, protocol: "http", name: "web" }]);

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/80"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 10,
    });

    expect(plan.environment).toMatchObject({
      LANDO: "ON",
      LANDO_APP_NAME: "myapp",
      LANDO_APP_KIND: "user",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT: "myapp",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_API: "4",
      LANDO_SERVICE_NAME: "web",
      LANDO_SERVICE_TYPE: "php:8.2",
      LANDO_WEBROOT: "/app",
      APACHE_DOCUMENT_ROOT: "/app",
    });

    expect(plan.extensions["lando-service-php"]).toEqual({
      allowOverride: false,
      webroot: "/app",
      version: "8.2",
      via: "apache",
    });
    expect(apacheLauncherDirectives(plan.command, "apache2-foreground")).not.toContain("AllowOverride All");
  });

  test("derives appName from appRoot basename when no explicit appName is provided", async () => {
    const plan = await composeServicePlan({
      serviceType: php82ServiceType,
      service: decodeService({ type: "php:8.2" }),
      appRoot: "/srv/apps/anotherapp",
      serviceName: "web",
      metadata,
      featureOverrides,
    });

    expect(plan.environment.LANDO_APP_NAME).toBe("anotherapp");
    expect(plan.environment.LANDO_PROJECT).toBe("anotherapp");
  });

  test("does not infer a webroot or AllowOverride policy from framework=drupal", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2", framework: "drupal" });

    expect(String(plan.workingDirectory)).toBe("/app");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app");
    expect(apacheLauncherDirectives(plan.command, "apache2-foreground")).not.toContain("AllowOverride All");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ allowOverride: false, webroot: "/app" });
  });

  test("framework=wordpress keeps the app root as webroot", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2", framework: "wordpress" });

    expect(String(plan.workingDirectory)).toBe("/app");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ allowOverride: false });
  });

  test("uses an explicit service webroot without enabling AllowOverride", async () => {
    const plan = await composePhpPlan(php82ServiceType, {
      type: "php:8.2",
      webroot: "/app/public",
    });

    expect(String(plan.workingDirectory)).toBe("/app/public");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/public");
    expect(apacheLauncherDirectives(plan.command, "apache2-foreground")).not.toContain("AllowOverride All");
  });

  test("enables AllowOverride only when the service explicitly requests it", async () => {
    const plan = await composePhpPlan(php82ServiceType, {
      type: "php:8.2",
      webroot: "/app/web",
      allowOverride: true,
    });

    expect(String(plan.workingDirectory)).toBe("/app/web");
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/web");
    expect(apacheLauncherDirectives(plan.command, "apache2-foreground")).toContain("AllowOverride All");
  });

  test("user environment overrides framework defaults", async () => {
    const plan = await composePhpPlan(php82ServiceType, {
      type: "php:8.2",
      webroot: "/app/web",
      environment: { APACHE_DOCUMENT_ROOT: "/app/custom", FOO: "bar" },
    });

    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/custom");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app/web");
    expect(plan.environment.FOO).toBe("bar");
  });

  test("propagates user image override and custom port", async () => {
    const plan = await composePhpPlan(php82ServiceType, {
      type: "php:8.2",
      image: "registry.example.com/php:8.2-custom",
      port: 8080,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/php:8.2-custom" });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 8080, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.kind).toBe("command");
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"]);
  });
});

describe("php:8.3 ServiceType", () => {
  test("plans a default PHP 8.3 service", async () => {
    const plan = await composePhpPlan(php83ServiceType, { type: "php:8.3" });

    expect(plan.type).toBe("php:8.3");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.3-apache-bookworm" });
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("php:8.3");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ version: "8.3" });
  });

  test("rejects unsupported PHP versions with remediation", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php83ServiceType, { type: "php:9.0" }),
      /Unsupported PHP version "9.0"\./,
    );

    await expectRejectsToThrow(
      composePhpPlan(php83ServiceType, { type: "php:9.0" }),
      /Set type to one of: php:8.1, php:8.2, php:8.3, php:8.4, php:8.5, php:8.6/,
    );
  });

  test("rejects versions outside the supported catalog", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, { type: "php:9.0" }),
      /Unsupported PHP version "9.0"/,
    );
  });

  test("rejects user environment that targets reserved LANDO_* keys", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, {
        type: "php:8.2",
        environment: { LANDO_PROJECT: "evil", FOO: "bar" },
      }),
      /reserved LANDO_\* keys.*LANDO_PROJECT/,
    );
  });

  test("rejects bare reserved key 'LANDO' on user environment", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, {
        type: "php:8.2",
        environment: { LANDO: "OFF" },
      }),
      /reserved LANDO_\* keys.*LANDO/,
    );
  });
});

describe("php:8.5 ServiceType", () => {
  test("plans a default PHP 8.5 service with the shared extension set", async () => {
    const plan = await composePhpPlan(php85ServiceType, { type: "php:8.5" });

    expect(plan.type).toBe("php:8.5");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.5-apache-bookworm" });
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("php:8.5");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ version: "8.5" });
  });

  test("rejects composer 2.7.7 when planning php:8.5", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php85ServiceType, { type: "php:8.5", composer: "2.7.7" }),
      /cannot run on PHP 8\.5/,
    );
  });
});

describe("php:8.6 ServiceType", () => {
  test("plans a selectable PHP 8.6 service against the official RC bookworm image", async () => {
    const plan = await composePhpPlan(php86ServiceType, { type: "php:8.6" });

    expect(plan.type).toBe("php:8.6");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.6-rc-apache-bookworm" });
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("php:8.6");
    expect(plan.extensions["lando-service-php"]).toMatchObject({ version: "8.6" });
  });

  test("rejects composer 2.7.7 when planning php:8.6", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php86ServiceType, { type: "php:8.6", composer: "2.7.7" }),
      /cannot run on PHP 8\.6/,
    );
  });

  test("rejects xdebug on php:8.6 because the shipped pin stops at 8.5", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php86ServiceType, { type: "php:8.6", xdebug: true }),
      /Xdebug is not available on PHP 8\.6/,
    );
    await expectRejectsToThrow(
      composePhpPlan(php86ServiceType, { type: "php:8.6", xdebug: true }),
      /Remove xdebug: or set type to php:8\.5/,
    );
  });
});

describe("php serving modes (via:)", () => {
  test("via apache is the explicit apache image and HTTP listener", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2", via: "apache" });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.2-apache-bookworm" });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 80, protocol: "http", name: "web" }]);
    expect(plan.command?.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(plan.command?.[2]).toContain('LANDO_HOST_OS:-}" = win32');
    expect(plan.command?.[2]).toContain("stat -c '%u:%g'");
    expect(plan.command?.[2]).toContain('usermod --uid "$lando_mount_uid" --gid "$lando_mount_gid" www-data');
  });

  test("starts a non-root Apache-served PHP service without writing config from PID 1", async () => {
    // Given / When: an identity the image ships, with home persistence declined
    // so the planned user is the only thing under test.
    const plan = await composePhpPlan(php83ServiceType, {
      type: "php:8.3",
      via: "apache",
      user: "www-data",
      home: false,
    });

    // Then: the planned user reaches the container and the launcher it runs
    // needs nothing that only root can do.
    expect(plan.user).toBe("www-data");
    const directives = apacheLauncherDirectives(plan.command, "apache2-foreground");
    expect(directives).toContain('DocumentRoot "/app"');

    const argv = plan.command as ReadonlyArray<string>;
    expect(argv).not.toContain("sh");
    expect(argv.filter((token) => token.includes("/etc/apache2"))).toEqual([]);
    expect(argv.join("\n")).not.toMatch(/>\s*\//u);
  });

  test("authored command keeps the image default site", async () => {
    const plan = await composePhpPlan(php83ServiceType, {
      type: "php:8.3",
      via: "apache",
      port: 8080,
      command: ["apache2-foreground"],
    });

    expect(plan.command).toEqual(["apache2-foreground"]);
    const ids = buildStepsFor(plan).map((step) => step.id);
    expect(ids).not.toContain(APACHE_DEFAULT_SITE_BUILD_STEP_ID);
    expect(ids).not.toContain(LANDO_ERROR_PAGES_BUILD_STEP_ID);
    expect(ids).not.toContain(APACHE_LISTEN_BUILD_STEP_ID);
  });

  test("authored entrypoint keeps the image default site", async () => {
    const plan = await composePhpPlan(php83ServiceType, {
      type: "php:8.3",
      via: "apache",
      port: 8080,
      entrypoint: ["/custom-start"],
    });

    expect(plan.entrypoint).toEqual(["/custom-start"]);
    const ids = buildStepsFor(plan).map((step) => step.id);
    expect(ids).not.toContain(APACHE_DEFAULT_SITE_BUILD_STEP_ID);
    expect(ids).not.toContain(LANDO_ERROR_PAGES_BUILD_STEP_ID);
    expect(ids).not.toContain(APACHE_LISTEN_BUILD_STEP_ID);
  });

  test("via apache derives its virtual host and listener from an authored port", async () => {
    // Given / When: an authored port on the default Apache-served shape.
    const plan = await composePhpPlan(php83ServiceType, { type: "php:8.3", via: "apache", port: 8080 });

    // Then: the launcher listens there and serves the app from a virtual host
    // bound to the same value, still as one synthetic directive stream.
    expect(apacheLauncherDirectives(plan.command, "apache2-foreground")).toEqual([
      "Listen 8080",
      "<VirtualHost *:8080>",
      'DocumentRoot "/app"',
      '<Directory "/app">',
      "Options -Indexes +FollowSymLinks",
      "AllowOverride None",
      "Require all granted",
      "</Directory>",
      ...apacheErrorPageDirectives(),
      "</VirtualHost>",
    ]);

    // And: the image's own listener is deleted during the build, so the service
    // answers on the planned port and not also on 80.
    const step = buildStepsFor(plan).find(({ id }) => id === APACHE_LISTEN_BUILD_STEP_ID);
    expect(step?.user).toBe("root");
    expect(String((step?.command as ReadonlyArray<string> | undefined)?.[2] ?? "")).toContain(
      "/etc/apache2/ports.conf",
    );
  });

  test("via apache without an authored port keeps the main-server launcher", async () => {
    // Given / When: no port, which is the shape every existing app already has.
    const plan = await composePhpPlan(php83ServiceType, { type: "php:8.3", via: "apache" });

    // Then: byte-identical directives, and the image keeps its own listener.
    expect(apacheLauncherDirectives(plan.command, "apache2-foreground")).toEqual([
      'DocumentRoot "/app"',
      '<Directory "/app">',
      "Options -Indexes +FollowSymLinks",
      "AllowOverride None",
      "Require all granted",
      "</Directory>",
      ...apacheErrorPageDirectives(),
    ]);
    expect(buildStepsFor(plan).map(({ id }) => id)).not.toContain(APACHE_LISTEN_BUILD_STEP_ID);
  });

  test("a custom image owns its own listener", async () => {
    // Given / When: an image Lando did not build the launcher for.
    const plan = await composePhpPlan(php83ServiceType, {
      type: "php:8.3",
      image: "registry.example.com/php:8.3-custom",
      port: 8080,
    });

    // Then: Lando edits no configuration it does not own.
    expect(buildStepsFor(plan).map(({ id }) => id)).not.toContain(APACHE_LISTEN_BUILD_STEP_ID);
  });

  test("an authored /app mount replaces the default app-root bind", async () => {
    const plan = await composePhpPlan(php83ServiceType, {
      type: "php:8.3",
      mounts: [{ source: "./alternate", target: "/app", readOnly: true }],
    });

    expect(plan.appMount).toBeUndefined();
    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]).toMatchObject({
      type: "bind",
      source: "/srv/apps/myapp/alternate",
      target: "/app",
      readOnly: true,
    });
  });

  test("plans authored PHP ini bind mounts alongside the app mount", async () => {
    const appRoot = "C:\\Users\\aaron\\Windows Projects\\windows-cms-fresh";
    const plan = await composePhpPlan(
      php83ServiceType,
      {
        type: "php:8.3",
        mounts: [
          {
            source: "./.lando/php/drupal-cms.ini",
            target: "/usr/local/etc/php/conf.d/zz-lando-drupal-cms.ini",
            readOnly: true,
          },
        ],
      },
      appRoot,
    );

    expect(plan.mounts).toHaveLength(2);
    expect(plan.mounts[1]).toMatchObject({
      type: "bind",
      source: `${appRoot}\\.lando\\php\\drupal-cms.ini`,
      target: "/usr/local/etc/php/conf.d/zz-lando-drupal-cms.ini",
      readOnly: true,
      realization: "passthrough",
    });
  });
  test("via fpm uses the fpm image and listens on 9000", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2", via: "fpm" });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.2-fpm-bookworm" });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 9000, protocol: "tcp", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9000"]);
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBeUndefined();
    expect(plan.command?.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(plan.command?.[2]).toContain("listen = 9000");
    expect(plan.command?.[2]).toContain('LANDO_HOST_OS:-}" = win32');
    expect(plan.command?.[2]).toContain("stat -c '%u:%g'");
    expect(plan.command?.[2]).toContain('usermod --uid "$lando_mount_uid" --gid "$lando_mount_gid" www-data');
    expect(plan.command?.[2]).toContain("exec php-fpm");
    expect(plan.command).not.toContain("apache2-foreground");
  });

  test("starts a non-root FPM PHP service without writing into the image config tree", async () => {
    // Given / When: an identity the image ships, with home persistence declined
    // so the planned user is the only thing under test.
    const plan = await composePhpPlan(php83ServiceType, {
      type: "php:8.3",
      via: "fpm",
      user: "www-data",
      home: false,
    });

    // Then: the pool override lands where that user can write and php-fpm is
    // pointed at it explicitly, rather than at the image's own pool directory.
    expect(plan.user).toBe("www-data");
    expect(plan.command?.slice(0, 2)).toEqual(["sh", "-c"]);
    const script = String(plan.command?.[2] ?? "");
    expect(script).toContain("exec php-fpm -y /tmp/lando-php-fpm.conf");
    expect(script).toContain("include=/usr/local/etc/php-fpm.conf");
    expect(script).toContain("listen = 9000");
    expect(script).not.toContain("/usr/local/etc/php-fpm.d");
    expect([...script.matchAll(/>\s*(\S+)/gu)].map((match) => match[1])).toEqual(["/tmp/lando-php-fpm.conf"]);
    // FPM serves no HTML, so it installs none of the shared error pages.
    expect(buildStepsFor(plan).map((step) => step.id)).not.toContain(LANDO_ERROR_PAGES_BUILD_STEP_ID);
  });

  test.each(["apache", "fpm"] as const)(
    "preserves an explicit service user for via %s without root-only worker remapping",
    async (via) => {
      const plan = await composePhpPlan(php82ServiceType, {
        type: "php:8.2",
        via,
        user: "root",
      });

      expect(plan.user).toBe("root");
      expect(plan.command?.[2]).not.toContain("lando_mount_owner");
      expect(plan.command?.[2]).not.toContain("usermod");
    },
  );

  test("via fpm listens on an authored port", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2", via: "fpm", port: 9070 });

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 9070, protocol: "tcp", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9070"]);
    expect(plan.command?.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(plan.command?.[2]).toContain("listen = 9070");
    expect(plan.command?.[2]).toContain("exec php-fpm");
  });

  test("via fpm applies webroot as the working directory", async () => {
    const plan = await composePhpPlan(php82ServiceType, {
      type: "php:8.2",
      via: "fpm",
      webroot: "/app/web",
    });

    expect(String(plan.workingDirectory)).toBe("/app/web");
    expect(plan.environment.LANDO_WEBROOT).toBe("/app/web");
  });

  test("via cli idles without a web server or HTTP route", async () => {
    const plan = await composePhpPlan(php82ServiceType, { type: "php:8.2", via: "cli" });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "php:8.2-cli-bookworm" });
    expect(plan.endpoints).toEqual([]);
    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.environment.APACHE_DOCUMENT_ROOT).toBeUndefined();
  });

  test("rejects unknown via with remediation", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, { type: "php:8.2", via: "nginx" }),
      /Unsupported PHP serving mode "nginx"\./,
    );
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, { type: "php:8.2", via: "nginx" }),
      /via: apache, via: fpm, or via: cli/,
    );
  });

  test("rejects allowOverride under fpm", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, { type: "php:8.2", via: "fpm", allowOverride: true }),
      /allowOverride/,
    );
  });

  test("rejects allowOverride under cli", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, { type: "php:8.2", via: "cli", allowOverride: false }),
      /allowOverride/,
    );
  });

  test("rejects HTTP routes under cli", async () => {
    await expectRejectsToThrow(
      composePhpPlan(php82ServiceType, {
        type: "php:8.2",
        via: "cli",
        routes: [{ hostname: "app.lndo.site" }],
      }),
      /routes/,
    );
  });
});
