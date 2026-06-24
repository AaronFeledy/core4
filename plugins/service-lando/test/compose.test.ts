import { homedir } from "node:os";

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { composeServiceType } from "../src/services/compose.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

describe("compose ServiceType (raw passthrough)", () => {
  test("accepts image:, short-form ports, and named volumes", () => {
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

    const plan = composeServiceType.__legacyToServicePlan({
      name: "worker",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.type).toBe("compose");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "ghcr.io/example/worker:1.2.3" });
    expect(plan.environment).toMatchObject({ WORKER_ENV: "prod" });
    expect(plan.endpoints).toEqual([
      { port: 9000, protocol: "tcp", name: "worker" },
      { port: 9001, protocol: "udp", name: "worker" },
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
    expect(plan.environment.LANDO_APP_ROOT).toBe("/app");
    expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/app");
  });

  test("accepts relative bind volumes resolved against appRoot", () => {
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

    const plan = composeServiceType.__legacyToServicePlan({
      name: "worker",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]).toMatchObject({
      type: "bind",
      source: "/srv/apps/myapp/config",
      target: "/etc/worker",
      readOnly: true,
    });
    expect(plan.storage).toEqual([]);
  });

  test("accepts Compose composeBuild: block", () => {
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

    const plan = composeServiceType.__legacyToServicePlan({
      name: "api",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.artifact).toMatchObject({
      kind: "build",
      context: "/srv/apps/myapp/services/api",
      spec: "Dockerfile.prod",
      args: { NODE_ENV: "production" },
      target: "runtime",
    });
  });

  test("routes provider-specific extensions through service.providers.<id>", () => {
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

    const plan = composeServiceType.__legacyToServicePlan({
      name: "api",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.extensions).toEqual({
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

    expect(() =>
      composeServiceType.__legacyToServicePlan({
        name: "api",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      }),
    ).toThrow(/requires either "image:" or "composeBuild:"/);
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

    expect(() =>
      composeServiceType.__legacyToServicePlan({
        name: "api",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      }),
    ).toThrow(/must declare exactly one of "image:" or "composeBuild:"/);
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

    expect(() =>
      composeServiceType.__legacyToServicePlan({
        name: "api",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      }),
    ).toThrow(/does not accept Lando "build:".*Use "composeBuild:"/);
  });

  describe("tilde expansion in volume bind sources", () => {
    test("~/data:/data expands ~ to homedir", () => {
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

      const plan = composeServiceType.__legacyToServicePlan({
        name: "db",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      });

      expect(plan.mounts).toHaveLength(1);
      expect(plan.mounts[0]).toMatchObject({
        type: "bind",
        source: `${homedir()}/data`,
        target: "/data",
        readOnly: false,
      });
    });

    test("~:/home/app expands bare ~ to homedir", () => {
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

      const plan = composeServiceType.__legacyToServicePlan({
        name: "app",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      });

      expect(plan.mounts).toHaveLength(1);
      expect(plan.mounts[0]).toMatchObject({
        type: "bind",
        source: homedir(),
        target: "/home/app",
        readOnly: false,
      });
    });

    test("./data:/data relative path still resolves under appRoot", () => {
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

      const plan = composeServiceType.__legacyToServicePlan({
        name: "web",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      });

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
    test("emits a default app-root bind mount at /app plus LANDO_APP_ROOT/LANDO_PROJECT_MOUNT", () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: { worker: { type: "compose", image: "alpine:3" } },
      });
      const service = landofile.services?.[ServiceName.make("worker")];
      if (service === undefined) throw new Error("worker service missing");

      const plan = composeServiceType.__legacyToServicePlan({
        name: "worker",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      });

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
      expect(plan.environment.LANDO_APP_ROOT).toBe("/app");
      expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/app");
    });

    test("appMount: false opts out — no appMount, no synthetic /app bind, no app-path env", () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: { worker: { type: "compose", image: "alpine:3", appMount: false } },
      });
      const service = landofile.services?.[ServiceName.make("worker")];
      if (service === undefined) throw new Error("worker service missing");

      const plan = composeServiceType.__legacyToServicePlan({
        name: "worker",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      });

      expect(plan.appMount).toBeUndefined();
      expect(plan.mounts).toEqual([]);
      expect(plan.environment.LANDO_APP_ROOT).toBeUndefined();
      expect(plan.environment.LANDO_PROJECT_MOUNT).toBeUndefined();
    });

    test("default app-root bind precedes user volume bind mounts", () => {
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

      const plan = composeServiceType.__legacyToServicePlan({
        name: "worker",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      });

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
