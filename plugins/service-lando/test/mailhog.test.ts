import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import type { DeprecationUse } from "@lando/sdk/schema";
import { MAILHOG_DEPRECATION_NOTICE, MailhogServiceConfig } from "@lando/sdk/schema/services/mailhog";
import type { DeprecationSummaryEntry, ServiceType } from "@lando/sdk/services";
import { DeprecationService } from "@lando/sdk/services";
import {
  MAILHOG_FEATURE_ID,
  MAILHOG_IMAGE,
  mailhogServiceFeature,
  mailhogServiceType,
} from "../src/services/mailhog.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-19T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[MAILHOG_FEATURE_ID, mailhogServiceFeature]]);

const testDeprecationLayer = () => {
  const uses = new Map<string, { readonly use: DeprecationUse; count: number }>();
  return Layer.succeed(DeprecationService, {
    use: (use) =>
      Effect.sync(() => {
        const key = `${use.kind}:${use.id}`;
        const existing = uses.get(key);
        uses.set(key, { use: existing?.use ?? use, count: (existing?.count ?? 0) + 1 });
      }),
    summary: () =>
      Effect.sync(
        (): ReadonlyArray<DeprecationSummaryEntry> =>
          [...uses.values()].map((record) => ({ ...record.use, count: record.count })),
      ),
    lookup: () => Effect.succeed(Option.none()),
    register: () => Effect.void,
    registerAlias: () => Effect.void,
  });
};

const serviceConfig = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { mail: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("mail")];
  if (service === undefined) throw new Error("mail service missing");
  return service;
};

const planMailhogService = async (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType,
    service: serviceConfig(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "mail",
    metadata,
    featureOverrides,
  });

describe("mailhog ServiceType", () => {
  test("plans the compatibility defaults", async () => {
    const plan = await planMailhogService(mailhogServiceType, { type: "mailhog" });

    expect(mailhogServiceType.base).toBe("lando");
    expect(mailhogServiceType.schema).toBe(MailhogServiceConfig);
    expect(plan.type).toBe("mailhog");
    expect(plan.artifact).toEqual({ kind: "ref", ref: MAILHOG_IMAGE });
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 1025, protocol: "tcp", name: "smtp" },
      { _tag: "internal", port: 8025, protocol: "http", name: "ui" },
    ]);
    expect(plan.environment).toMatchObject({ MH_SMTP_BIND_ADDR: "0.0.0.0:1025" });
  });

  test("binds SMTP to an authored port", async () => {
    const plan = await planMailhogService(mailhogServiceType, { type: "mailhog", port: 2525 });

    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 2525, protocol: "tcp", name: "smtp" },
      { _tag: "internal", port: 8025, protocol: "http", name: "ui" },
    ]);
    expect(plan.environment).toMatchObject({ MH_SMTP_BIND_ADDR: "0.0.0.0:2525" });
  });

  test("resolves a default web UI route", async () => {
    const resolution = await Effect.runPromise(
      mailhogServiceType.resolve({
        name: "mail",
        service: serviceConfig({ type: "mailhog" }),
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        metadata,
      }),
    );

    expect(resolution.normalizedConfig.routes).toEqual([
      { hostname: "mail.myapp.lndo.site", endpoint: 8025 },
    ]);
  });

  test("records deprecation-used with the catalog notice", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const deprecations = yield* DeprecationService;
        yield* mailhogServiceType.resolve({
          name: "mail",
          service: serviceConfig({ type: "mailhog" }),
          appRoot: "/srv/apps/myapp",
          appName: "legacy-app",
          metadata,
        });
        return yield* deprecations.summary();
      }).pipe(Effect.provide(testDeprecationLayer())),
    );

    expect(summary).toHaveLength(1);
    expect(summary[0]?.kind).toBe("service-type");
    expect(summary[0]?.id).toBe("mailhog");
    expect(summary[0]?.app).toBe("legacy-app");
    expect(summary[0]?.count).toBe(1);
    expect(summary[0]?.notice).toEqual(MAILHOG_DEPRECATION_NOTICE);
  });

  test("dedupes repeated uses onto one summary row", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const deprecations = yield* DeprecationService;
        const input = {
          name: "mail",
          service: serviceConfig({ type: "mailhog" }),
          appRoot: "/srv/apps/myapp",
          appName: "legacy-app",
          metadata,
        };
        yield* mailhogServiceType.resolve(input);
        yield* mailhogServiceType.resolve(input);
        return yield* deprecations.summary();
      }).pipe(Effect.provide(testDeprecationLayer())),
    );

    expect(summary).toHaveLength(1);
    expect(summary[0]?.count).toBe(2);
  });
});
