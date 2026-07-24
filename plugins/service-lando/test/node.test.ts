import { describe, expect, test } from "bun:test";
import { Either, ParseResult, Schema } from "effect";

import { LandofileShape, ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  NODE_FEATURE_ID,
  SUPPORTED_NODE_VERSIONS,
  node22ServiceType,
  nodeLtsServiceType,
  nodeServiceFeature,
} from "../src/services/node.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-15T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[NODE_FEATURE_ID, nodeServiceFeature]]);

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const composeNodePlan = (serviceType: ServiceType, raw: unknown): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
    service: decodeService(raw),
    appRoot: APP_ROOT,
    appName: "myapp",
    serviceName: "web",
    metadata,
    featureOverrides,
    applyAuthoredWrappers: false,
  });

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

describe("node ServiceType — supported versions", () => {
  test("exposes lts and 22 as supported versions", () => {
    expect([...SUPPORTED_NODE_VERSIONS]).toEqual(["lts", "22"]);
  });
});

describe("node:lts ServiceType", () => {
  test("plans a default Node LTS service", async () => {
    const plan = await composeNodePlan(nodeLtsServiceType, { type: "node:lts" });

    expect(plan.type).toBe("node:lts");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "node:lts" });
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);
    expect(plan.appMount?.excludes).toEqual([]);
    expect(plan.appMount?.includes).toEqual([]);
    expect(plan.appMount?.realization).toBe("passthrough");
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");
    expect(plan.mounts[0]?.readOnly).toBe(false);
    expect(plan.mounts[0]?.realization).toBe("passthrough");
    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 3000, protocol: "http", name: "web" }]);
    expect(plan.environment).toMatchObject({
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_NAME: "web",
      LANDO_SERVICE_TYPE: "node:lts",
    });
    expect(plan.environment.LANDO_WEBROOT).toBeUndefined();
  });

  test("propagates user overrides", async () => {
    const plan = await composeNodePlan(nodeLtsServiceType, {
      type: "node:lts",
      image: "node:22",
      command: "npm start",
      environment: { NODE_ENV: "development" },
      ports: ["3001:3000"],
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "node:22" });
    expect(plan.command).toBe("npm start");
    expect(plan.environment).toMatchObject({ NODE_ENV: "development" });
    expect(plan.endpoints).toEqual([
      { _tag: "published", port: 3000, protocol: "http", name: "web", publication: { hostPort: 3001 } },
    ]);
  });

  test("ServiceConfig schema accepts the framework field", () => {
    const result = Schema.decodeUnknownEither(ServiceConfig)(
      { type: "node:lts", framework: "drupal" },
      {
        onExcessProperty: "error",
      },
    );

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.framework).toBe("drupal");
    }
  });

  test("node:lts ServiceType ignores framework but never crashes", async () => {
    const plan = await composeNodePlan(nodeLtsServiceType, {
      type: "node:lts",
      framework: "drupal",
    });

    expect(plan.type).toBe("node:lts");
    expect("framework" in plan).toBe(false);
  });

  test("ServiceConfig still rejects unknown excess keys via strict decoding", () => {
    const result = Schema.decodeUnknownEither(ServiceConfig)(
      { type: "node:lts", nonsenseKey: "value" },
      { onExcessProperty: "error" },
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("nonsenseKey"))).toBe(true);
    }
  });

  test("plan is a valid providerExec target: long-running command + app workdir", async () => {
    const plan = await composeNodePlan(nodeLtsServiceType, { type: "node:lts" });

    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.name).toBe(ServiceName.make("web"));
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(String(plan.appMount?.target)).toBe("/app");
  });
});

describe("node:22 ServiceType", () => {
  test("plans a default Node 22 service", async () => {
    const plan = await composeNodePlan(node22ServiceType, { type: "node:22" });

    expect(plan.type).toBe("node:22");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "node:22" });
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");
    expect(plan.mounts[0]?.realization).toBe("passthrough");
    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 3000, protocol: "http", name: "web" }]);
    expect(plan.environment).toMatchObject({
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_NAME: "web",
      LANDO_SERVICE_TYPE: "node:22",
    });
    expect(plan.environment.LANDO_WEBROOT).toBeUndefined();
  });

  test("propagates user overrides including custom image and ports", async () => {
    const plan = await composeNodePlan(node22ServiceType, {
      type: "node:22",
      image: "node:22-alpine",
      command: "npm run dev",
      environment: { NODE_ENV: "development" },
      ports: ["3001:3000"],
    });

    expect(plan.type).toBe("node:22");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "node:22-alpine" });
    expect(plan.command).toBe("npm run dev");
    expect(plan.environment).toMatchObject({ NODE_ENV: "development" });
    expect(plan.endpoints).toEqual([
      { _tag: "published", port: 3000, protocol: "http", name: "web", publication: { hostPort: 3001 } },
    ]);
  });

  test("passes through entrypoint and dependsOn", async () => {
    const plan = await composeNodePlan(node22ServiceType, {
      type: "node:22",
      entrypoint: ["docker-entrypoint.sh"],
      dependsOn: ["database"],
    });

    expect(plan.entrypoint).toEqual(["docker-entrypoint.sh"]);
    expect(plan.dependsOn).toEqual([{ service: ServiceName.make("database"), condition: "started" }]);
  });

  test("rejects unsupported node versions with remediation", async () => {
    await expectRejectsToThrow(
      composeNodePlan(node22ServiceType, { type: "node:18" }),
      /Unsupported Node version "18".*Set type to one of: node:lts, node:22/,
    );
  });

  test("plan is a valid providerExec target: long-running command + app workdir", async () => {
    const plan = await composeNodePlan(node22ServiceType, { type: "node:22" });

    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.name).toBe(ServiceName.make("web"));
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(String(plan.appMount?.target)).toBe("/app");
  });
});
