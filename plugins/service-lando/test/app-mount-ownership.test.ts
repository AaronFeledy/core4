import { describe, expect, test } from "bun:test";
import { PortablePath, type ServiceConfig } from "@lando/sdk/schema";

import { serviceTypes } from "../src/index.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const planService = async (type: string, service: ServiceConfig = {}) => {
  const definition = serviceTypes.get(type);
  if (definition === undefined) throw new Error(`Missing type ${type}`);
  return composeServicePlan({
    serviceType: definition,
    service: { type, ...service },
    appRoot: "/srv/project",
    appName: "mount-test",
    metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/srv/project/.lando.yml", runtime: 4 },
  });
};

const families = [
  "php:8.3",
  "nginx",
  "apache",
  "static:nginx",
  "node:22",
  "python:3.12",
  "ruby:3.3",
  "go:1.23",
  "lando",
  "dotnet:8.0",
  "tomcat",
  "compose",
] as const;

describe("app-mount ownership", () => {
  for (const type of families) {
    const webroot = ["php:8.3", "nginx", "apache", "static:nginx", "tomcat"].includes(type)
      ? { webroot: PortablePath.make("/srv/www") }
      : {};
    test(`disables the mount and mount-derived defaults when ${type} opts out`, async () => {
      // Given
      const service: ServiceConfig = {
        appMount: false,
        ...webroot,
        ...(type === "lando" || type === "compose" ? { image: "alpine:3.21" } : {}),
      };
      // When
      const plan = await planService(type, service);
      // Then
      expect(plan.appMount).toBeUndefined();
      expect(plan.mounts.some((mount) => mount.type === "bind" && mount.source === "/srv/project")).toBe(
        false,
      );
      expect(plan.environment.LANDO_APP_ROOT).toBeUndefined();
      expect(plan.environment.LANDO_PROJECT_MOUNT).toBeUndefined();
      expect(plan.workingDirectory).toBeUndefined();
    });
    if (type !== "compose") {
      test(`preserves an authored working directory when ${type} opts out`, async () => {
        // Given
        const service: ServiceConfig = {
          appMount: false,
          ...webroot,
          workingDirectory: PortablePath.make("/custom"),
          ...(type === "lando" ? { image: "alpine:3.21" } : {}),
        };
        // When
        const plan = await planService(type, service);
        // Then
        expect(String(plan.workingDirectory)).toBe("/custom");
      });
    }
  }

  for (const mounts of [
    ["./other:/app/./"],
    [{ source: "./other", target: "/app/../app" }],
  ] satisfies readonly NonNullable<ServiceConfig["mounts"]>[]) {
    test(`replaces the synthetic apache mount when an authored ${typeof mounts[0]} mount occupies its target`, async () => {
      // Given an authored mount whose destination has an equivalent spelling.
      const service = { mounts };
      // When
      const plan = await planService("apache", service);
      // Then the authored mount replaces app-source intent while path defaults remain.
      expect(plan.appMount).toBeUndefined();
      expect(plan.mounts).toMatchObject([{ type: "bind", source: "/srv/project/other", target: "/app" }]);
      expect(plan.environment.LANDO_APP_ROOT).toBe("/app");
      expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/app");
      expect(String(plan.workingDirectory)).toBe("/app");
    });
  }

  test("leaves data stores unmounted when the base feature has no target", async () => {
    // Given a data-store type without app-mount defaults.
    // When
    const plan = await planService("redis");
    // Then
    expect(plan.appMount).toBeUndefined();
  });

  for (const type of ["redis", "mariadb", "php:8.3", "compose", "lando"]) {
    test(`realizes authored mounts exactly once and in order for ${type}`, async () => {
      // Given
      const service: ServiceConfig = {
        ...(type === "compose" || type === "lando" ? { image: "alpine:3.21" } : {}),
        mounts: ["./config:/etc/service:ro", { type: "tmpfs", target: "/scratch" }],
      };
      // When
      const plan = await planService(type, service);
      // Then
      expect(plan.mounts).toHaveLength(2);
      expect(plan.mounts).toMatchObject([
        { type: "bind", source: "/srv/project/config", target: "/etc/service", readOnly: true },
        { type: "tmpfs", target: "/scratch", readOnly: false },
      ]);
    });
  }

  for (const image of ["traefik:v3.6", "axllent/mailpit:v1.29", "lando/ssh-agent:latest"]) {
    test(`preserves authored mounts when global-style compose ${image} disables its app mount`, async () => {
      // Given
      const service: ServiceConfig = {
        image,
        appMount: false,
        mounts: ["/var/run/docker.sock:/var/run/docker.sock:ro", "./config:/etc/service:ro"],
      };
      // When
      const plan = await planService("compose", service);
      // Then
      expect(plan.appMount).toBeUndefined();
      expect(plan.mounts).toHaveLength(2);
      expect(plan.mounts).toMatchObject([
        { source: "/var/run/docker.sock", target: "/var/run/docker.sock", readOnly: true },
        { source: "/srv/project/config", target: "/etc/service", readOnly: true },
      ]);
    });
  }

  test("keeps the tomcat app mount independent of an absolute webroot", async () => {
    // Given
    const service = {
      webroot: PortablePath.make("/usr/local/tomcat/webapps/site"),
    };
    // When
    const plan = await planService("tomcat", service);
    // Then the app mount owns path env and cwd, independently of the document root.
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.environment.LANDO_APP_ROOT).toBe("/app");
    expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/app");
    expect(plan.environment.LANDO_WEBROOT).toBe("/usr/local/tomcat/webapps/site");
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(plan.mounts.some((mount) => mount.source === "/srv/project")).toBe(false);
  });

  test("moves tomcat app intent and resolves its relative webroot", async () => {
    // Given a moved mount and a relative document root.
    const service = {
      webroot: PortablePath.make("public"),
      appMount: { target: "/workspace" },
    };
    // When
    const plan = await planService("tomcat", service);
    // Then
    expect(String(plan.appMount?.target)).toBe("/workspace");
    expect(plan.environment.LANDO_WEBROOT).toBe("/workspace/public");
    expect(String(plan.workingDirectory)).toBe("/workspace");
  });

  test("moves compose app intent without lando path env or cwd", async () => {
    // Given
    const service = { image: "alpine:3.21", appMount: { target: "/workspace" } };
    // When
    const plan = await planService("compose", service);
    // Then app-source intent moves without Lando process defaults or a mirror bind.
    expect(String(plan.appMount?.target)).toBe("/workspace");
    expect(plan.environment.LANDO_APP_ROOT).toBeUndefined();
    expect(plan.environment.LANDO_PROJECT_MOUNT).toBeUndefined();
    expect(plan.workingDirectory).toBeUndefined();
    expect(plan.mounts.some((mount) => mount.source === "/srv/project")).toBe(false);
  });
});
