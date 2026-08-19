import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, RabbitMQServiceConfig, ServiceName } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  RABBITMQ_FEATURE_ID,
  rabbitmq3ServiceType,
  rabbitmq4ServiceType,
  rabbitmqServiceFeature,
  rabbitmqServiceType,
} from "../src/services/rabbitmq.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-18T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[RABBITMQ_FEATURE_ID, rabbitmqServiceFeature]]);

const serviceConfig = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { queue: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("queue")];
  if (service === undefined) throw new Error("queue service missing");
  return service;
};

const planRabbitMQService = async (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType,
    service: serviceConfig(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "queue",
    metadata,
    featureOverrides,
  });

const resolveRabbitMQService = (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  Effect.runPromise(
    serviceType.resolve({
      name: "queue",
      service: serviceConfig(serviceDefinition),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
    }),
  );

describe("rabbitmq ServiceType", () => {
  for (const [id, image, serviceType] of [
    ["rabbitmq:3", "rabbitmq:3-management", rabbitmq3ServiceType],
    ["rabbitmq:4", "rabbitmq:4-management", rabbitmq4ServiceType],
    ["rabbitmq", "rabbitmq:4-management", rabbitmqServiceType],
  ] as const) {
    describe(id, () => {
      test("plans the catalog defaults", async () => {
        const plan = await planRabbitMQService(serviceType, { type: id });

        expect(serviceType.base).toBe("lando");
        expect(serviceType.schema).toBe(RabbitMQServiceConfig);
        expect(plan.type).toBe("rabbitmq");
        expect(plan.artifact).toEqual({ kind: "ref", ref: image });
        expect(plan.endpoints).toEqual([
          { _tag: "internal", port: 5672, protocol: "tcp", name: "queue" },
          { _tag: "internal", port: 15672, protocol: "http", name: "management" },
        ]);
        expect(plan.storage).toHaveLength(1);
        expect(plan.storage[0]?.store).toBe("myapp-rabbitmq-data");
        expect(String(plan.storage[0]?.target)).toBe("/var/lib/rabbitmq");
        expect(plan.storage[0]?.readOnly).toBe(false);
        expect(plan.environment).toMatchObject({
          RABBITMQ_DEFAULT_USER: "lando",
          RABBITMQ_DEFAULT_PASS: "lando",
        });
        expect(plan.healthcheck).toEqual({
          kind: "command",
          command: ["rabbitmq-diagnostics", "-q", "ping"],
          intervalSeconds: 10,
          timeoutSeconds: 5,
          retries: 5,
          startPeriodSeconds: 30,
        });
      });

      test("resolves default routes and tooling", async () => {
        const resolution = await resolveRabbitMQService(serviceType, { type: id });

        expect(resolution.normalizedConfig.routes).toEqual([
          { hostname: "queue.myapp.lndo.site", endpoint: 15672 },
        ]);
        expect(resolution.tooling).toEqual({
          rabbitmqctl: { service: "queue", cmd: "rabbitmqctl" },
          rabbitmqadmin: { service: "queue", cmd: ["rabbitmqadmin", "-u", "lando", "-p", "lando"] },
        });
      });

      test("preserves rabbitmqadmin credentials as literal argv", async () => {
        const resolution = await resolveRabbitMQService(serviceType, {
          type: id,
          environment: {
            RABBITMQ_DEFAULT_USER: "user name",
            RABBITMQ_DEFAULT_PASS: "pa'ss; rm -rf /",
          },
        });

        expect(resolution.tooling?.rabbitmqadmin).toEqual({
          service: "queue",
          cmd: ["rabbitmqadmin", "-u", "user name", "-p", "pa'ss; rm -rf /"],
        });
      });

      test("authored routes replace the default route", async () => {
        const routes = [{ hostname: "mq.example.test", scheme: "https", endpoint: 15672 }] as const;
        const resolution = await resolveRabbitMQService(serviceType, { type: id, routes });

        expect(resolution.normalizedConfig.routes).toEqual(routes);
      });

      test("preserves authored runtime overrides", async () => {
        const plan = await planRabbitMQService(serviceType, {
          type: id,
          image: "rabbitmq:custom",
          port: 25672,
          environment: { RABBITMQ_DEFAULT_USER: "author", EXTRA_VAR: "extra" },
          command: ["rabbitmq-server"],
          entrypoint: ["/bin/sh", "-c"],
          workingDirectory: "/var/lib/rabbitmq",
          user: "1000:1000",
        });

        expect(plan.artifact).toEqual({ kind: "ref", ref: "rabbitmq:custom" });
        expect(plan.endpoints).toEqual([
          { _tag: "internal", port: 25672, protocol: "tcp", name: "queue" },
          { _tag: "internal", port: 15672, protocol: "http", name: "management" },
        ]);
        expect(plan.environment).toMatchObject({
          RABBITMQ_DEFAULT_USER: "author",
          RABBITMQ_DEFAULT_PASS: "lando",
          EXTRA_VAR: "extra",
        });
        expect(plan.command).toEqual(["rabbitmq-server"]);
        expect(plan.entrypoint).toEqual(["/bin/sh", "-c"]);
        expect(String(plan.workingDirectory)).toBe("/var/lib/rabbitmq");
        expect(plan.user).toBe("1000:1000");
      });
    });
  }

  test("declares supported versions and artifacts", () => {
    expect(rabbitmqServiceType.versions).toEqual(["3", "4"]);
    expect(rabbitmqServiceType.artifacts).toEqual({
      "3": "rabbitmq:3-management",
      "4": "rabbitmq:4-management",
    });
  });
});
