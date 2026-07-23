import { homedir } from "node:os";

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";

import { COMPOSE_FEATURE_ID, composeServiceFeature, composeServiceType } from "../src/services/compose.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[COMPOSE_FEATURE_ID, composeServiceFeature]]);

const planComposeService = (args: {
  readonly service: ServiceConfig;
  readonly serviceName?: string;
  readonly appRoot?: string;
}) =>
  composeServicePlan({
    serviceType: composeServiceType,
    service: args.service,
    appRoot: args.appRoot ?? "/srv/apps/myapp",
    metadata,
    serviceName: args.serviceName ?? "worker",
    featureOverrides,
  });

const landoEnvKeys = (environment: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.keys(environment).filter((key) => key === "LANDO" || key.startsWith("LANDO_"));

const expectComposePlanRejects = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  try {
    await promise;
  } catch (cause) {
    expect(cause).toBeInstanceOf(Error);
    if (!(cause instanceof Error)) return;
    expect(cause.message).toMatch(pattern);
    return;
  }
  throw new Error(`Expected compose planning to reject with ${pattern}`);
};

describe("compose ServiceType (raw passthrough)", () => {
  test("accepts image:, short-form ports, and named volumes", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        worker: {
          type: "compose",
          image: "ghcr.io/example/worker:1.2.3",
          ports: ["9000:9000", "9001:9001/udp"],
          volumes: ["worker-data:/var/lib/worker"],
          environment: { WORKER_ENV: "prod" },
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("worker")];
    if (service === undefined) throw new Error("worker service missing");

    const plan = await planComposeService({ service, serviceName: "worker" });

    expect(plan.type).toBe("compose");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "ghcr.io/example/worker:1.2.3" });
    expect(plan.environment).toMatchObject({ WORKER_ENV: "prod" });
    expect(plan.endpoints).toEqual([
      {
        _tag: "published",
        port: 9000,
        protocol: "tcp",
        name: "worker",
        publication: { hostPort: 9000 },
      },
      {
        _tag: "published",
        port: 9001,
        protocol: "udp",
        name: "worker",
        publication: { hostPort: 9001 },
      },
    ]);
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-worker-data");
    expect(String(plan.storage[0]?.target)).toBe("/var/lib/worker");
    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]).toMatchObject({
      type: "bind",
      source: "/srv/apps/myapp",
      target: "/app",
      readOnly: false,
    });
    expect(plan.appMount).toMatchObject({ source: "/srv/apps/myapp", target: "/app", readOnly: false });
    // Compose uses the l337 base and must not inject LANDO_* env.
    expect(plan.environment.LANDO_APP_ROOT).toBeUndefined();
    expect(plan.environment.LANDO_PROJECT_MOUNT).toBeUndefined();
  });

  test("composed environment contains no injected LANDO_* unless user authored", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        worker: {
          type: "compose",
          image: "ghcr.io/example/worker:1.2.3",
          environment: { WORKER_ENV: "prod" },
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("worker")];
    if (service === undefined) throw new Error("worker service missing");

    const plan = await planComposeService({ service, serviceName: "worker" });

    expect(plan.environment.WORKER_ENV).toBe("prod");
    // Compose uses the l337 base and must not inject LANDO_* env.
    expect(landoEnvKeys(plan.environment)).toEqual([]);
  });

  test("accepts relative bind volumes resolved against appRoot", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        worker: {
          type: "compose",
          image: "alpine:3",
          appMount: false,
          volumes: ["./config:/etc/worker:ro"],
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("worker")];
    if (service === undefined) throw new Error("worker service missing");

    const plan = await planComposeService({ service, serviceName: "worker" });

    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]).toMatchObject({
      type: "bind",
      source: "/srv/apps/myapp/config",
      target: "/etc/worker",
      readOnly: true,
    });
    expect(plan.storage).toEqual([]);
  });

  test("accepts Compose composeBuild: block", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        api: {
          type: "compose",
          composeBuild: {
            context: "./services/api",
            dockerfile: "Dockerfile.prod",
            args: { NODE_ENV: "production" },
            target: "runtime",
          },
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("api")];
    if (service === undefined) throw new Error("api service missing");

    const plan = await planComposeService({ service, serviceName: "api" });

    expect(plan.artifact).toMatchObject({
      kind: "build",
      context: "/srv/apps/myapp/services/api",
      spec: "Dockerfile.prod",
      args: { NODE_ENV: "production" },
      target: "runtime",
    });
  });

  test("routes provider-specific extensions through service.providers.<id>", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        api: {
          type: "compose",
          image: "alpine:3",
          providers: {
            lando: { labels: { "com.example.team": "platform" } },
            docker: { restart: "unless-stopped" },
          },
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("api")];
    if (service === undefined) throw new Error("api service missing");

    const plan = await planComposeService({ service, serviceName: "api" });

    expect(plan.extensions).toEqual({
      "@lando/core/service-features": { featureIds: ["service-lando.compose"] },
      lando: { labels: { "com.example.team": "platform" } },
      docker: { restart: "unless-stopped" },
    });
  });

  test("rejects compose service without image: or composeBuild:", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { api: { type: "compose" } },
    });
    const service = landofile.services?.[ServiceName.make("api")];
    if (service === undefined) throw new Error("api service missing");

    return expectComposePlanRejects(
      planComposeService({ service, serviceName: "api" }),
      /requires either "image:" or "composeBuild:"/,
    );
  });

  test("rejects compose service that declares both image: and composeBuild:", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        api: {
          type: "compose",
          image: "alpine:3",
          composeBuild: { context: "./svc" },
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("api")];
    if (service === undefined) throw new Error("api service missing");

    return expectComposePlanRejects(
      planComposeService({ service, serviceName: "api" }),
      /must declare exactly one of "image:" or "composeBuild:"/,
    );
  });

  test("rejects Lando-style build: blocks (use composeBuild instead)", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        api: {
          type: "compose",
          image: "alpine:3",
          build: { artifact: "RUN echo hi" },
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("api")];
    if (service === undefined) throw new Error("api service missing");

    return expectComposePlanRejects(
      planComposeService({ service, serviceName: "api" }),
      /does not accept Lando "build:".*Use "composeBuild:"/,
    );
  });

  describe("tilde expansion in volume bind sources", () => {
    test("~/data:/data expands ~ to homedir", async () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: {
          db: {
            type: "compose",
            image: "alpine:3",
            appMount: false,
            volumes: ["~/data:/data"],
          },
        },
      });
      const service = landofile.services?.[ServiceName.make("db")];
      if (service === undefined) throw new Error("db service missing");

      const plan = await planComposeService({ service, serviceName: "db" });

      expect(plan.mounts).toHaveLength(1);
      expect(plan.mounts[0]).toMatchObject({
        type: "bind",
        source: `${homedir()}/data`,
        target: "/data",
        readOnly: false,
      });
    });

    test("~:/home/app expands bare ~ to homedir", async () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: {
          app: {
            type: "compose",
            image: "alpine:3",
            appMount: false,
            volumes: ["~:/home/app"],
          },
        },
      });
      const service = landofile.services?.[ServiceName.make("app")];
      if (service === undefined) throw new Error("app service missing");

      const plan = await planComposeService({ service, serviceName: "app" });

      expect(plan.mounts).toHaveLength(1);
      expect(plan.mounts[0]).toMatchObject({
        type: "bind",
        source: homedir(),
        target: "/home/app",
        readOnly: false,
      });
    });

    test("./data:/data relative path still resolves under appRoot", async () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: {
          web: {
            type: "compose",
            image: "alpine:3",
            appMount: false,
            volumes: ["./data:/data"],
          },
        },
      });
      const service = landofile.services?.[ServiceName.make("web")];
      if (service === undefined) throw new Error("web service missing");

      const plan = await planComposeService({ service, serviceName: "web" });

      expect(plan.mounts).toHaveLength(1);
      expect(plan.mounts[0]).toMatchObject({
        type: "bind",
        source: "/srv/apps/myapp/data",
        target: "/data",
        readOnly: false,
      });
    });
  });

  describe("default app-root bind mount and per-service opt-out", () => {
    test("emits a default app-root bind mount at /app without LANDO_APP_ROOT/LANDO_PROJECT_MOUNT", async () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: { worker: { type: "compose", image: "alpine:3" } },
      });
      const service = landofile.services?.[ServiceName.make("worker")];
      if (service === undefined) throw new Error("worker service missing");

      const plan = await planComposeService({ service, serviceName: "worker" });

      expect(plan.appMount).toMatchObject({
        source: "/srv/apps/myapp",
        target: "/app",
        readOnly: false,
      });
      expect(plan.mounts).toHaveLength(1);
      expect(plan.mounts[0]).toMatchObject({
        type: "bind",
        source: "/srv/apps/myapp",
        target: "/app",
        readOnly: false,
      });
      // Compose uses the l337 base and must not inject LANDO_* env.
      expect(plan.environment.LANDO_APP_ROOT).toBeUndefined();
      expect(plan.environment.LANDO_PROJECT_MOUNT).toBeUndefined();
    });

    test("appMount: false opts out — no appMount, no synthetic /app bind, no app-path env", async () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: { worker: { type: "compose", image: "alpine:3", appMount: false } },
      });
      const service = landofile.services?.[ServiceName.make("worker")];
      if (service === undefined) throw new Error("worker service missing");

      const plan = await planComposeService({ service, serviceName: "worker" });

      expect(plan.appMount).toBeUndefined();
      expect(plan.mounts).toEqual([]);
      expect(plan.environment.LANDO_APP_ROOT).toBeUndefined();
      expect(plan.environment.LANDO_PROJECT_MOUNT).toBeUndefined();
    });

    test("default app-root bind precedes user volume bind mounts", async () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: {
          worker: {
            type: "compose",
            image: "alpine:3",
            volumes: ["./config:/etc/worker:ro"],
          },
        },
      });
      const service = landofile.services?.[ServiceName.make("worker")];
      if (service === undefined) throw new Error("worker service missing");

      const plan = await planComposeService({ service, serviceName: "worker" });

      expect(plan.mounts).toHaveLength(2);
      expect(plan.mounts[0]).toMatchObject({ source: "/srv/apps/myapp", target: "/app" });
      expect(plan.mounts[1]).toMatchObject({
        type: "bind",
        source: "/srv/apps/myapp/config",
        target: "/etc/worker",
        readOnly: true,
      });
    });
  });
});
