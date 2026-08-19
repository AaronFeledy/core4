import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";
import { LocalStackServiceConfig } from "@lando/sdk/schema/services/localstack";

import {
  LOCALSTACK_FEATURE_ID,
  localstackServiceFeature,
  localstackServiceType,
} from "../src/services/localstack.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-18T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[LOCALSTACK_FEATURE_ID, localstackServiceFeature]]);

const localstackService = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { cloud: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("cloud")];
  if (service === undefined) throw new Error("cloud service missing");
  return service;
};

const planLocalStackService = (serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType: localstackServiceType,
    service: localstackService(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "cloud",
    metadata,
    featureOverrides,
  });

describe("localstack ServiceType", () => {
  test("plans the default artifact, persistent storage, and named HTTP endpoint", async () => {
    const plan = await planLocalStackService({ type: "localstack" });

    expect(plan.type).toBe("localstack");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "localstack/localstack:4.14.0" });
    expect(plan.environment).toMatchObject({ GATEWAY_LISTEN: "0.0.0.0:4566", PERSISTENCE: "1" });
    expect(plan.storage).toEqual([
      {
        store: "myapp-localstack-data",
        target: PortablePath.make("/var/lib/localstack"),
        readOnly: false,
      },
    ]);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 4566, protocol: "http", name: "cloud" }]);
  });

  test("respects image and port overrides on the gateway bind and healthcheck", async () => {
    const plan = await planLocalStackService({
      type: "localstack",
      image: "localstack/localstack:4.7",
      port: 14566,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "localstack/localstack:4.7" });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 14566, protocol: "http", name: "cloud" }]);
    expect(plan.environment).toMatchObject({ GATEWAY_LISTEN: "0.0.0.0:14566" });
  });

  test("healthcheck curls the LocalStack health endpoint on the authored port", async () => {
    const plan = await planLocalStackService({ type: "localstack", port: 14566 });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["sh", "-c", "curl -sf http://localhost:14566/_localstack/health"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });

  test("aligns GATEWAY_LISTEN with port when both are authored", async () => {
    const plan = await planLocalStackService({
      type: "localstack",
      port: 14566,
      environment: { GATEWAY_LISTEN: "127.0.0.1:4566" },
    });

    expect(plan.environment).toMatchObject({ GATEWAY_LISTEN: "127.0.0.1:14566" });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 14566, protocol: "http", name: "cloud" }]);
    expect(plan.healthcheck).toMatchObject({
      command: ["sh", "-c", "curl -sf http://localhost:14566/_localstack/health"],
    });
  });

  test("derives the planned port from GATEWAY_LISTEN when port is omitted", async () => {
    const plan = await planLocalStackService({
      type: "localstack",
      environment: { GATEWAY_LISTEN: "0.0.0.0:24666" },
    });

    expect(plan.environment).toMatchObject({ GATEWAY_LISTEN: "0.0.0.0:24666" });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 24666, protocol: "http", name: "cloud" }]);
    expect(plan.healthcheck).toMatchObject({
      command: ["sh", "-c", "curl -sf http://localhost:24666/_localstack/health"],
    });
  });

  test("preserves authored environment and process fields", async () => {
    const plan = await planLocalStackService({
      type: "localstack",
      environment: { DEBUG: "1", GATEWAY_LISTEN: "0.0.0.0:4566" },
      command: ["localstack", "start"],
      entrypoint: ["/usr/bin/env"],
      workingDirectory: "/var/lib/localstack",
      user: "1000:1000",
    });

    expect(plan.environment).toMatchObject({ DEBUG: "1", GATEWAY_LISTEN: "0.0.0.0:4566" });
    expect(plan.command).toEqual(["localstack", "start"]);
    expect(plan.entrypoint).toEqual(["/usr/bin/env"]);
    expect(String(plan.workingDirectory)).toBe("/var/lib/localstack");
    expect(plan.user).toBe("1000:1000");
  });

  test("resolves the awslocal tooling task and LocalStack feature", async () => {
    const resolution = await Effect.runPromise(
      localstackServiceType.resolve({
        name: "cloud",
        service: localstackService({ type: "localstack" }),
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        metadata,
      }),
    );

    expect(resolution.base).toBe("lando");
    expect(resolution.features).toEqual([{ id: LOCALSTACK_FEATURE_ID }]);
    expect(resolution.tooling?.awslocal).toEqual({ service: "cloud", cmd: "awslocal" });
  });

  test("publishes the LocalStack authoring schema", () => {
    expect(Object.is(localstackServiceType.schema, LocalStackServiceConfig)).toBe(true);
  });
});
