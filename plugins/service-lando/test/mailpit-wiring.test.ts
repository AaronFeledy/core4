import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { AppPlannerLive, PluginRegistryLive } from "@lando/core/testing";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { ServiceConfig } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { mailpitServiceType } from "../src/services/mailpit.ts";

const planEffect = (mailFrom: unknown, php = true) =>
  Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(
      Schema.decodeUnknownSync(LandofileShape)({
        name: "mail-demo",
        services: {
          mail: { type: "mailpit", ...(mailFrom === undefined ? {} : { mailFrom }) },
          ...(php
            ? {
                first: { type: "php:8.3", via: "cli", composer: false, db_client: false },
                second: { type: "php:8.3", via: "cli", composer: false, db_client: false },
              }
            : {}),
          cache: { type: "redis" },
        },
      }),
      TestRuntimeProvider.capabilities,
    ),
  ).pipe(Effect.provide(AppPlannerLive), Effect.provide(PluginRegistryLive));
const plan = (mailFrom: unknown, php = true) => Effect.runPromise(planEffect(mailFrom, php));

describe("Mailpit selected PHP senders", () => {
  test.each([
    "mail';touch /tmp/pwned;#",
    "mail$(id)",
    "mail\ninjected",
    "mail --tls=on",
    "mail`id`",
    'mail"',
    "",
    "-mail",
  ])("rejects unsafe SMTP service names at resolution: %j", async (name) => {
    // Given
    const service = Schema.decodeUnknownSync(ServiceConfig)({ type: "mailpit" });
    // When
    const result = await Effect.runPromise(
      Effect.either(
        mailpitServiceType.resolve({
          name,
          service,
          appRoot: "/srv/mail-demo",
          metadata: { runtime: 4, resolvedAt: "2026-09-13T00:00:00Z", source: "/srv/mail-demo/.lando.yml" },
        }),
      ),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ServiceTypeError" } });
  });
  test("deduplicates mailFrom by first occurrence without sorting authored order", async () => {
    // Given
    const service = Schema.decodeUnknownSync(ServiceConfig)({
      type: "mailpit",
      mailFrom: ["second", "first", "second", "first"],
    });
    // When
    const result = await Effect.runPromise(
      mailpitServiceType.resolve({
        name: "mail",
        service,
        appRoot: "/srv/mail-demo",
        metadata: { runtime: 4, resolvedAt: "2026-09-13T00:00:00Z", source: "/srv/mail-demo/.lando.yml" },
      }),
    );
    // Then
    expect(result.normalizedConfig.mailFrom).toEqual([ServiceName.make("second"), ServiceName.make("first")]);
  });
  test.each([
    [undefined, ["first", "second"]],
    [false, []],
    [[], []],
    [["second", "second"], ["second"]],
  ])("wires exactly the selected services for %j", async (mailFrom, expected) => {
    // Given / When
    const result = await plan(mailFrom);
    // Then
    const wired = Object.values(result.services).filter(
      (service) => service.environment.LANDO_MAIL_HOST === "mail",
    );
    expect(wired.map((service) => String(service.name))).toEqual(expected);
    for (const service of wired) {
      expect(JSON.stringify(service.extensions)).toContain("sendmail_path");
      expect(service.dependsOn).toContainEqual({
        service: ServiceName.make("mail"),
        condition: "service_started",
        required: true,
      });
    }
  });

  test.each([["missing"], ["cache"], ["second", "missing"]])(
    "rejects invalid targets before returning a provider plan: %j",
    async (...targets) => {
      // Given / When / Then
      const result = await Effect.runPromise(Effect.either(planEffect(targets)));
      expect(result).toMatchObject({ _tag: "Left", left: { _tag: "LandofileValidationError" } });
    },
  );

  test("accepts omitted targets when no PHP service resolves", async () => {
    // Given / When
    const result = await plan(undefined, false);
    // Then
    expect(
      Object.values(result.services).some((service) =>
        JSON.stringify(service.extensions).includes("sendmail_path"),
      ),
    ).toBe(false);
  });
});
