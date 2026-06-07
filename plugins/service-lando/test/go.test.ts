import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";

import {
  SUPPORTED_GO_FRAMEWORKS,
  SUPPORTED_GO_VERSIONS,
  go122ServiceType,
  go123ServiceType,
} from "../src/services/go.ts";

const metadata = {
  resolvedAt: "2026-05-27T20:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
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
  test("plans a default Go 1.22 web service with framework=none defaults", () => {
    const service = decodeService({ type: "go:1.22" });
    const plan = go122ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

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

    expect(plan.endpoints).toEqual([{ port: 8080, protocol: "http", name: "web" }]);

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 10,
    });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_APP_KIND).toBe("user");
    expect(plan.environment.LANDO_APP_ROOT).toBe("/app");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
    expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/app");
    expect(plan.environment.LANDO_SERVICE_API).toBe("4");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("web");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("go:1.22");

    expect(plan.environment.GOPATH).toBe("/go");
    expect(plan.environment.GOCACHE).toBe("/root/.cache/go-build");
    expect(plan.environment.CGO_ENABLED).toBe("0");

    expect(plan.extensions["lando-service-go"]).toEqual({
      framework: "none",
      version: "1.22",
      defaultCommand: null,
      port: 8080,
    });
  });

  test("derives appName from appRoot basename when no explicit appName is provided", () => {
    const service = decodeService({ type: "go:1.22" });
    const plan = go122ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/anotherapp",
      metadata,
    });
    expect(plan.environment.LANDO_APP_NAME).toBe("anotherapp");
    expect(plan.environment.LANDO_PROJECT).toBe("anotherapp");
  });

  test("user environment overrides go defaults but cannot override LANDO_*", () => {
    const service = decodeService({
      type: "go:1.22",
      environment: { CGO_ENABLED: "1", FOO: "bar" },
    });
    const plan = go122ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.environment.CGO_ENABLED).toBe("1");
    expect(plan.environment.FOO).toBe("bar");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
  });

  test("propagates user image override and custom port", () => {
    const service = decodeService({
      type: "go:1.22",
      image: "registry.example.com/golang:1.22-custom",
      port: 9090,
    });
    const plan = go122ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/golang:1.22-custom" });
    expect(plan.endpoints).toEqual([{ port: 9090, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9090"]);
    expect(plan.extensions["lando-service-go"]).toMatchObject({ port: 9090 });
  });

  test("plan uses provider-neutral ServicePlan fields", () => {
    const service = decodeService({ type: "go:1.22" });
    const plan = go122ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.extensions["lando-service-go"]).toBeDefined();
    expect(plan.artifact.kind).toBe("ref");
    expect(plan.endpoints[0]?.protocol).toBe("http");
    expect(plan.healthcheck?.kind).toBe("command");
    expect(Object.keys(plan)).not.toContain("providers");
    expect(Object.keys(plan)).not.toContain("providerInfo");
  });

  test("default command keeps the container alive so `lando go ...` tooling can exec into it", () => {
    const service = decodeService({ type: "go:1.22" });
    const plan = go122ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
  });

  test("rejects framework values outside the supported set with remediation", () => {
    const service = decodeService({ type: "go:1.22", framework: "echo" });
    expect(() =>
      go122ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Unsupported Go framework "echo"\./);

    expect(() =>
      go122ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Set framework to one of: none/);
  });

  test("rejects unsupported Go versions with remediation", () => {
    const service = decodeService({ type: "go:1.20" });
    expect(() =>
      go122ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Unsupported Go version "1.20"\./);

    expect(() =>
      go122ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Set type to one of: go:1.22, go:1.23/);
  });

  test("rejects user environment that targets reserved LANDO_* keys", () => {
    const service = decodeService({
      type: "go:1.22",
      environment: { LANDO_PROJECT: "evil", FOO: "bar" },
    });
    expect(() =>
      go122ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/reserved LANDO_\* keys.*LANDO_PROJECT/);
  });
});

describe("go:1.23 ServiceType", () => {
  test("plans a default Go 1.23 web service", () => {
    const service = decodeService({ type: "go:1.23" });
    const plan = go123ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.type).toBe("go:1.23");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "golang:1.23" });
    expect(plan.extensions["lando-service-go"]).toMatchObject({ version: "1.23" });
  });

  test("rejects unsupported Go versions through go:1.23 with full Go-family remediation", () => {
    const service = decodeService({ type: "go:1.21" });
    expect(() =>
      go123ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Unsupported Go version "1.21".*Set type to one of: go:1.22, go:1.23/);
  });
});
