import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { MailpitServiceConfig } from "@lando/sdk/schema/services/mailpit";
import type { ServiceType } from "@lando/sdk/services";

import { MAILPIT_IMAGE } from "../src/mailpit-constants.ts";
import { MAILPIT_FEATURE_ID, mailpitServiceFeature, mailpitServiceType } from "../src/services/mailpit.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-19T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[MAILPIT_FEATURE_ID, mailpitServiceFeature]]);

const serviceConfig = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { mail: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("mail")];
  if (service === undefined) throw new Error("mail service missing");
  return service;
};

const planMailpitService = async (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType,
    service: serviceConfig(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "mail",
    metadata,
    featureOverrides,
  });

describe("mailpit ServiceType", () => {
  test("plans the catalog defaults", async () => {
    const plan = await planMailpitService(mailpitServiceType, { type: "mailpit" });

    expect(mailpitServiceType.base).toBe("lando");
    expect(mailpitServiceType.schema).toBe(MailpitServiceConfig);
    expect(plan.type).toBe("mailpit");
    expect(plan.artifact).toEqual({ kind: "ref", ref: MAILPIT_IMAGE });
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 1025, protocol: "tcp", name: "smtp" },
      { _tag: "internal", port: 8025, protocol: "http", name: "ui" },
    ]);
    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["/mailpit", "readyz"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 15,
    });
  });

  test("resolves a default web UI route", async () => {
    const resolution = await Effect.runPromise(
      mailpitServiceType.resolve({
        name: "mail",
        service: serviceConfig({ type: "mailpit" }),
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        metadata,
      }),
    );

    expect(resolution.normalizedConfig.routes).toEqual([
      { hostname: "mail.myapp.lndo.site", endpoint: 8025 },
    ]);
  });

  test("authored routes replace the default route", async () => {
    const routes = [{ hostname: "inbox.example.test", scheme: "https", endpoint: 8025 }] as const;
    const resolution = await Effect.runPromise(
      mailpitServiceType.resolve({
        name: "mail",
        service: serviceConfig({ type: "mailpit", routes }),
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        metadata,
      }),
    );

    expect(resolution.normalizedConfig.routes).toEqual(routes);
  });
});
