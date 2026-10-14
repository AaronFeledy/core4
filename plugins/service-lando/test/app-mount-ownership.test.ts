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
    test(`disables the mount and mount-derived defaults when ${type} opts out`, async () => {
      // Given an opted-in service family with appMount disabled.
      const service = {
        appMount: false,
        ...(type === "lando" || type === "compose" ? { image: "alpine:3.21" } : {}),
      } as const;
      // When the service is composed.
      const plan = await planService(type, service);
      // Then neither a synthetic mount nor its process defaults remain.
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
        // Given a disabled mount and an explicit process directory.
        const service = {
          appMount: false,
          workingDirectory: PortablePath.make("/custom"),
          ...(type === "lando" ? { image: "alpine:3.21" } : {}),
        } as const;
        // When the service is composed.
        const plan = await planService(type, service);
        // Then the authored directory still owns the process field.
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
      // When apache is composed.
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
    const type = "redis";
    // When its base features are composed.
    const plan = await planService(type);
    // Then it has no synthetic app-source mount.
    expect(plan.appMount).toBeUndefined();
  });

  for (const type of ["redis", "mariadb", "php:8.3", "compose", "lando"]) {
    test(`realizes authored mounts exactly once and in order for ${type}`, async () => {
      // Given mixed authored mount syntax independent of the synthetic app mount.
      const service: ServiceConfig = {
        ...(type === "compose" || type === "lando" ? { image: "alpine:3.21" } : {}),
        mounts: ["./config:/etc/service:ro", { type: "tmpfs", target: "/scratch" }],
      };
      // When the real service features are composed.
      const plan = await planService(type, service);
      // Then both authored mounts are present once, in their authored order.
      expect(plan.mounts).toHaveLength(2);
      expect(plan.mounts).toMatchObject([
        { type: "bind", source: "/srv/project/config", target: "/etc/service", readOnly: true },
        { type: "tmpfs", target: "/scratch", readOnly: false },
      ]);
    });
  }

  for (const image of ["traefik:v3.6", "axllent/mailpit:v1.29", "lando/ssh-agent:latest"]) {
    test(`preserves authored mounts when global-style compose ${image} disables its app mount`, async () => {
      // Given a global-service-style config that opts out of app-source mounting.
      const service: ServiceConfig = {
        image,
        appMount: false,
        mounts: ["/var/run/docker.sock:/var/run/docker.sock:ro", "./config:/etc/service:ro"],
      };
      // When compose runs its configured app-mount feature.
      const plan = await planService("compose", service);
      // Then authored mounts remain exactly once without a synthetic mount.
      expect(plan.appMount).toBeUndefined();
      expect(plan.mounts).toHaveLength(2);
      expect(plan.mounts).toMatchObject([
        { source: "/var/run/docker.sock", target: "/var/run/docker.sock", readOnly: true },
        { source: "/srv/project/config", target: "/etc/service", readOnly: true },
      ]);
    });
  }

  test("uses tomcat webroot for its mount, path env, and default cwd", async () => {
    // Given a custom Tomcat deployment webroot.
    const service = {
      webroot: PortablePath.make("/usr/local/tomcat/webapps/site"),
    };
    // When Tomcat is composed.
    const plan = await planService("tomcat", service);
    // Then the deployment path owns app-source intent and process defaults.
    expect(String(plan.appMount?.target)).toBe("/usr/local/tomcat/webapps/site");
    expect(plan.environment.LANDO_APP_ROOT).toBe("/usr/local/tomcat/webapps/site");
    expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/usr/local/tomcat/webapps/site");
    expect(String(plan.workingDirectory)).toBe("/usr/local/tomcat/webapps/site");
    expect(plan.mounts.some((mount) => mount.source === "/srv/project")).toBe(false);
  });

  test("accepts a tomcat target when its canonical destination matches webroot", async () => {
    // Given equivalent spellings of the deployment path and authored mount target.
    const service = {
      webroot: PortablePath.make("/usr/local/tomcat/webapps/site"),
      appMount: { target: "/usr/local/tomcat/webapps/./site/" },
    };
    // When Tomcat is composed.
    const plan = await planService("tomcat", service);
    // Then the canonical target is accepted.
    expect(String(plan.appMount?.target)).toBe("/usr/local/tomcat/webapps/site");
  });

  test("rejects a tomcat target when it differs from the deployment webroot", async () => {
    // Given conflicting deployment and mount targets.
    const service = {
      webroot: PortablePath.make("/usr/local/tomcat/webapps/site"),
      appMount: { target: "/workspace" },
    };
    // When Tomcat is composed.
    const result = planService("tomcat", service);
    // Then the failure names the deployment path and remediation.
    await expect(result).rejects.toThrow(
      /tomcat.*webroot.*\/usr\/local\/tomcat\/webapps\/site.*webroot.*appMount.target/,
    );
  });

  test("moves compose app intent without lando path env or cwd", async () => {
    // Given a raw Compose service with a moved app-source mount.
    const service = { image: "alpine:3.21", appMount: { target: "/workspace" } };
    // When its l337-base features are composed.
    const plan = await planService("compose", service);
    // Then app-source intent moves without Lando process defaults or a mirror bind.
    expect(String(plan.appMount?.target)).toBe("/workspace");
    expect(plan.environment.LANDO_APP_ROOT).toBeUndefined();
    expect(plan.environment.LANDO_PROJECT_MOUNT).toBeUndefined();
    expect(plan.workingDirectory).toBeUndefined();
    expect(plan.mounts.some((mount) => mount.source === "/srv/project")).toBe(false);
  });
});
