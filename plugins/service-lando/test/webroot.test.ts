import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";

import { resolveWebroot } from "../src/services/_webroot.ts";
import { apacheServiceType } from "../src/services/apache.ts";
import { nginxServiceType } from "../src/services/nginx.ts";
import { php82ServiceType } from "../src/services/php.ts";
import { staticNginxServiceType } from "../src/services/static.ts";
import { tomcatServiceType } from "../src/services/tomcat.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

describe("shared webroot resolution", () => {
  test.each(["/site/", "/site//./", "/other/../site"])(
    "normalizes the app mount %s before resolving a relative webroot",
    (target) => {
      expect(resolveWebroot("nginx", "public", { target: PortablePath.make(target) })).toBe("/site/public");
    },
  );

  test.each([undefined, "public"])(
    "rejects relative webroot %s when the app mount is disabled",
    (webroot) => {
      expect(() => resolveWebroot("nginx", webroot, false)).toThrow(
        `nginx webroot "${webroot ?? "."}" is relative to the app mount, but appMount is false. Set webroot to an absolute container path, or remove appMount: false.`,
      );
    },
  );

  test("normalizes an absolute webroot when the app mount is disabled", () => {
    expect(resolveWebroot("nginx", "//srv/./www/", false)).toBe("/srv/www");
  });

  test("names the effective app mount when rejecting unsafe webroot characters", () => {
    expect(() => resolveWebroot("nginx", "$host", { target: PortablePath.make("/site") })).toThrow(
      "nginx webroot must be a path relative to the app mount (/site), such as public, or an absolute container path, using only letters, digits, '.', '_', '-', and '/'.",
    );
  });

  test.each([
    [undefined, "/app"],
    [".", "/app"],
    ["web", "/app/web"],
    ["./public/", "/app/public"],
    ["/srv/www", "/srv/www"],
    ["/app/../srv", "/srv"],
    ["//srv/./www//", "/srv/www"],
    ["/", "/"],
  ] as const)("resolves %s to %s", (authored, resolved) => {
    expect(resolveWebroot("PHP", authored)).toBe(resolved);
  });

  test.each(["../srv", "public/../.."])("rejects escaping relative path %s", (authored) => {
    expect(() => resolveWebroot("PHP", authored)).toThrow(
      `PHP webroot ${authored} leaves the app mount (/app); use an absolute container path instead.`,
    );
  });

  test.each(["/app/$host", "web root", ""])("rejects unsafe path %s", (authored) => {
    expect(() => resolveWebroot("PHP", authored)).toThrow(
      "PHP webroot must be a path relative to the app mount (/app), such as public, or an absolute container path, using only letters, digits, '.', '_', '-', and '/'.",
    );
  });
});

describe("resolved service document roots", () => {
  for (const [type, serviceType, directive] of [
    ["nginx", nginxServiceType, "root"],
    ["php:8.2", php82ServiceType, "DocumentRoot"],
  ] as const) {
    test.each([
      ["public", "/site/public"],
      [undefined, "/site"],
      [".", "/site"],
      ["/srv/www", "/srv/www"],
    ] as const)(`${type} resolves webroot %s against the custom app mount`, async (webroot, resolved) => {
      // Given: the whole app is mounted somewhere other than /app.
      const config = Schema.decodeUnknownSync(LandofileShape)({
        services: {
          web: { type, appMount: { target: "/site" }, ...(webroot === undefined ? {} : { webroot }) },
        },
      });
      const service = config.services?.[ServiceName.make("web")];
      if (service === undefined) throw new Error("web service missing");
      // When: the service is composed with the authored mount wrapper.
      const plan = await composeServicePlan({ serviceType, service, appRoot: "/srv/apps/myapp", metadata });
      // Then: the launcher, working directory, and webroot environment agree with that mount.
      expect(String(plan.appMount?.target)).toBe("/site");
      expect(plan.environment.LANDO_WEBROOT).toBe(resolved);
      expect(String(plan.workingDirectory)).toBe(resolved);
      expect(Array.isArray(plan.command) ? plan.command.join(" ") : String(plan.command)).toContain(
        `${directive} "${resolved}"`,
      );
    });

    test(`${type} names the custom app mount when a relative webroot escapes it`, async () => {
      // Given: a relative webroot outside the custom app mount.
      const config = Schema.decodeUnknownSync(LandofileShape)({
        services: { web: { type, appMount: { target: "/site" }, webroot: "../x" } },
      });
      const service = config.services?.[ServiceName.make("web")];
      if (service === undefined) throw new Error("web service missing");
      // When / Then: planning rejects it with the effective mount in the error.
      await expect(
        composeServicePlan({ serviceType, service, appRoot: "/srv/apps/myapp", metadata }),
      ).rejects.toThrow(
        `${type === "nginx" ? "nginx" : "PHP"} webroot ../x leaves the app mount (/site); use an absolute container path instead.`,
      );
    });
  }

  const cases = [
    ["php:8.2", php82ServiceType, 'DocumentRoot "/app/public"'],
    ["static", staticNginxServiceType, 'root "/app/public";'],
    ["nginx", nginxServiceType, 'root "/app/public";'],
    ["apache", apacheServiceType, 'DocumentRoot "/app/public"'],
  ] as const;

  for (const [type, serviceType, directive] of cases) {
    test(`${type} plans relative roots without rewriting authored config`, async () => {
      const config = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: { web: { type, webroot: "./public/" } },
      });
      const service = config.services?.[ServiceName.make("web")];
      if (service === undefined) throw new Error("web service missing");
      const input = {
        serviceType,
        service,
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        serviceName: "web",
        metadata,
      };

      const resolution = await Effect.runPromise(serviceType.resolve({ ...input, name: "web" }));
      const plan = await composeServicePlan(input);

      expect(String(resolution.normalizedConfig.webroot)).toBe("./public/");
      expect(plan.environment.LANDO_WEBROOT).toBe("/app/public");
      expect(Array.isArray(plan.command) ? plan.command.join(" ") : String(plan.command)).toContain(
        directive,
      );
      if (type === "php:8.2" || type === "apache") {
        expect(plan.environment.APACHE_DOCUMENT_ROOT).toBe("/app/public");
      }
      if (type === "php:8.2" || type === "nginx") {
        expect(String(plan.workingDirectory)).toBe("/app/public");
      }
      if (type === "static") {
        expect(plan.extensions["lando-service-static"]).toMatchObject({ webroot: "/app/public" });
      }
    });
  }

  test.each(["../x", "/usr/local/tomcat/webapps/$host"])(
    "Tomcat rejects deployment path %s during resolution",
    async (webroot) => {
      const config = Schema.decodeUnknownSync(LandofileShape)({
        services: { java: { type: "tomcat", webroot } },
      });
      const service = config.services?.[ServiceName.make("java")];
      if (service === undefined) throw new Error("java service missing");
      const result = await Effect.runPromise(
        Effect.result(
          tomcatServiceType.resolve({
            name: "java",
            service,
            appRoot: "/srv/apps/myapp",
            appName: "myapp",
            metadata,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ServiceTypeError");
        expect(result.failure.message).toContain("tomcat webroot");
      }
    },
  );

  test("Tomcat normalizes its deploy mount without rewriting the authored path", async () => {
    // Given: an absolute deployment path containing redundant segments.
    const webroot = "/usr/local/tomcat/webapps/../webapps/ROOT";
    const config = Schema.decodeUnknownSync(LandofileShape)({
      services: { java: { type: "tomcat", webroot } },
    });
    const service = config.services?.[ServiceName.make("java")];
    if (service === undefined) throw new Error("java service missing");
    const input = {
      serviceType: tomcatServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "java",
      metadata,
    };

    // When: the service is resolved and composed into a plan.
    const resolution = await Effect.runPromise(tomcatServiceType.resolve({ ...input, name: "java" }));
    const plan = await composeServicePlan(input);

    // Then: only the runtime mount is normalized.
    expect(String(resolution.normalizedConfig.webroot)).toBe(webroot);
    expect(String(plan.appMount?.target)).toBe("/app");
  });

  for (const [type, serviceType, label] of [
    ["php:8.2", php82ServiceType, "PHP"],
    ["nginx", nginxServiceType, "nginx"],
    ["apache", apacheServiceType, "Apache"],
    ["static", staticNginxServiceType, "Static"],
    ["tomcat", tomcatServiceType, "tomcat"],
  ] as const) {
    test.each([undefined, "public"])(`${type} rejects webroot %s with appMount false`, async (webroot) => {
      // Given: a code-free web service with an app-relative document root.
      const config = Schema.decodeUnknownSync(LandofileShape)({
        services: { web: { type, appMount: false, ...(webroot === undefined ? {} : { webroot }) } },
      });
      const service = config.services?.[ServiceName.make("web")];
      if (service === undefined) throw new Error("web service missing");
      // When / Then: type resolution rejects the missing app mount.
      await expect(
        composeServicePlan({ serviceType, service, appRoot: "/srv/apps/myapp", metadata }),
      ).rejects.toThrow(
        `${label} webroot "${webroot ?? "."}" is relative to the app mount, but appMount is false. Set webroot to an absolute container path, or remove appMount: false.`,
      );
    });

    test(`${type} accepts an image document root with appMount false`, async () => {
      // Given: an absolute image-provided document root.
      const config = Schema.decodeUnknownSync(LandofileShape)({
        services: { web: { type, appMount: false, webroot: "/srv/www" } },
      });
      const service = config.services?.[ServiceName.make("web")];
      if (service === undefined) throw new Error("web service missing");
      // When: the service is planned.
      const plan = await composeServicePlan({ serviceType, service, appRoot: "/srv/apps/myapp", metadata });
      // Then: image content is served without app code or app-root environment.
      expect(plan.appMount).toBeUndefined();
      expect(plan.environment.LANDO_APP_ROOT).toBeUndefined();
      expect(plan.environment.LANDO_PROJECT_MOUNT).toBeUndefined();
      expect(plan.workingDirectory).toBeUndefined();
      expect(plan.environment.LANDO_WEBROOT).toBe("/srv/www");
    });
  }
});
