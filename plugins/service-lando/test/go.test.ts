import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  GO_FEATURE_ID,
  SUPPORTED_GO_FRAMEWORKS,
  SUPPORTED_GO_VERSIONS,
  go122ServiceType,
  go123ServiceType,
  goServiceFeature,
} from "../src/services/go.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-27T20:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[GO_FEATURE_ID, goServiceFeature]]);

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const composeGoPlan = (serviceType: ServiceType, raw: unknown, appRoot = APP_ROOT): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
    service: decodeService(raw),
    appRoot,
    appName: "myapp",
    serviceName: "web",
    metadata,
    featureOverrides,
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

describe("go ServiceType — supported versions and frameworks", () => {
  test("exposes 1.22 and 1.23 as the supported go versions", () => {
    expect([...SUPPORTED_GO_VERSIONS]).toEqual(["1.22", "1.23"]);
  });

  test("exposes none as the only supported go framework (scope)", () => {
    expect([...SUPPORTED_GO_FRAMEWORKS]).toEqual(["none"]);
  });
});

describe("go:1.22 ServiceType", () => {
  test("plans a default Go 1.22 web service with framework=none defaults", async () => {
    const plan = await composeGoPlan(go122ServiceType, { type: "go:1.22" });

    expect(plan.type).toBe("go:1.22");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "golang:1.22" });
    expect(plan.primary).toBe(true);
    expect(String(plan.workingDirectory)).toBe("/app");

    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);

    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");
    expect(plan.mounts[0]?.readOnly).toBe(false);

    expect(plan.endpoints).toEqual([{ port: 8080, protocol: "http", name: "web" }]);

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"],
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
      LANDO_SERVICE_TYPE: "go:1.22",
      GOPATH: "/go",
      GOCACHE: "/root/.cache/go-build",
      CGO_ENABLED: "0",
    });

    expect(plan.extensions["lando-service-go"]).toEqual({
      framework: "none",
      version: "1.22",
      defaultCommand: null,
      port: 8080,
    });
  });

  test("derives appName from appRoot basename when no explicit appName is provided", async () => {
    const plan = await composeServicePlan({
      serviceType: go122ServiceType,
      service: decodeService({ type: "go:1.22" }),
      appRoot: "/srv/apps/anotherapp",
      serviceName: "web",
      metadata,
      featureOverrides,
    });

    expect(plan.environment.LANDO_APP_NAME).toBe("anotherapp");
    expect(plan.environment.LANDO_PROJECT).toBe("anotherapp");
  });

  test("user environment overrides go defaults but cannot override LANDO_*", async () => {
    const plan = await composeGoPlan(go122ServiceType, {
      type: "go:1.22",
      environment: { CGO_ENABLED: "1", FOO: "bar" },
    });

    expect(plan.environment).toMatchObject({
      CGO_ENABLED: "1",
      FOO: "bar",
      LANDO_PROJECT: "myapp",
    });
  });

  test("propagates user image override and custom port", async () => {
    const plan = await composeGoPlan(go122ServiceType, {
      type: "go:1.22",
      image: "registry.example.com/golang:1.22-custom",
      port: 9090,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/golang:1.22-custom" });
    expect(plan.endpoints).toEqual([{ port: 9090, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9090"]);
    expect(plan.extensions["lando-service-go"]).toMatchObject({ port: 9090 });
  });

  test("plan uses provider-neutral ServicePlan fields", async () => {
    const plan = await composeGoPlan(go122ServiceType, { type: "go:1.22" });

    expect(plan.extensions["lando-service-go"]).toBeDefined();
    expect(plan.artifact?.kind).toBe("ref");
    expect(plan.endpoints[0]?.protocol).toBe("http");
    expect(plan.endpoints[0]?.name).toBe("web");
    expect(plan.healthcheck?.kind).toBe("command");
    expect(Object.keys(plan)).not.toContain("providers");
    expect(Object.keys(plan)).not.toContain("providerInfo");
  });

  test("default command keeps the container alive so `lando go ...` tooling can exec into it", async () => {
    const plan = await composeGoPlan(go122ServiceType, { type: "go:1.22" });

    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
  });

  test("rejects framework values outside the supported set with remediation", async () => {
    await expectRejectsToThrow(
      composeGoPlan(go122ServiceType, { type: "go:1.22", framework: "echo" }),
      /Unsupported Go framework "echo"\./,
    );

    await expectRejectsToThrow(
      composeGoPlan(go122ServiceType, { type: "go:1.22", framework: "echo" }),
      /Set framework to one of: none/,
    );
  });

  test("rejects unsupported Go versions with remediation", async () => {
    await expectRejectsToThrow(
      composeGoPlan(go122ServiceType, { type: "go:1.20" }),
      /Unsupported Go version "1.20"\./,
    );

    await expectRejectsToThrow(
      composeGoPlan(go122ServiceType, { type: "go:1.20" }),
      /Set type to one of: go:1.22, go:1.23/,
    );
  });

  test("rejects user environment that targets reserved LANDO_* keys", async () => {
    await expectRejectsToThrow(
      composeGoPlan(go122ServiceType, {
        type: "go:1.22",
        environment: { LANDO_PROJECT: "evil", FOO: "bar" },
      }),
      /reserved LANDO_\* keys.*LANDO_PROJECT/,
    );
  });
});

describe("go:1.23 ServiceType", () => {
  test("plans a default Go 1.23 web service", async () => {
    const plan = await composeGoPlan(go123ServiceType, { type: "go:1.23" });

    expect(plan.type).toBe("go:1.23");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "golang:1.23" });
    expect(plan.extensions["lando-service-go"]).toMatchObject({ version: "1.23" });
  });

  test("rejects unsupported Go versions through go:1.23 with full Go-family remediation", async () => {
    await expectRejectsToThrow(
      composeGoPlan(go123ServiceType, { type: "go:1.21" }),
      /Unsupported Go version "1.21".*Set type to one of: go:1.22, go:1.23/,
    );
  });
});
