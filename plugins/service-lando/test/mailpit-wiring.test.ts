import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import { AppPlannerLive } from "@lando/engine/services/planner";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { ServiceConfig } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { mailpitServiceType } from "../src/services/mailpit.ts";

const planEffect = (mailFrom: unknown, php = true, firstOverrides: Record<string, unknown> = {}) =>
  Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(
      Schema.decodeUnknownSync(LandofileShape)({
        name: "mail-demo",
        services: {
          mail: { type: "mailpit", ...(mailFrom === undefined ? {} : { mailFrom }) },
          ...(php
            ? {
                first: {
                  type: "php:8.3",
                  via: "cli",
                  composer: false,
                  db_client: false,
                  ...firstOverrides,
                },
                second: { type: "php:8.3", via: "cli", composer: false, db_client: false },
              }
            : {}),
          cache: { type: "redis" },
        },
      }),
      TestRuntimeProvider.capabilities,
    ),
  ).pipe(Effect.provide(AppPlannerLive), Effect.provide(PluginRegistryLive));
const plan = (mailFrom: unknown, php = true, firstOverrides: Record<string, unknown> = {}) =>
  Effect.runPromise(planEffect(mailFrom, php, firstOverrides));

const plannedService = (
  result: {
    readonly services: Readonly<Record<string, { readonly extensions: Readonly<Record<string, unknown>> }>>;
  },
  name: string,
) => {
  const service = result.services[ServiceName.make(name)];
  if (service === undefined) throw new Error(`missing planned service ${name}`);
  return service;
};

interface PlannedBuildStep {
  readonly id?: string;
  readonly command: string;
  readonly buildKeyInputs?: Record<string, unknown>;
}

const msmtpStep = (service: { readonly extensions: Readonly<Record<string, unknown>> }): PlannedBuildStep => {
  const features = service.extensions["@lando/core/service-features"] as
    | { readonly buildSteps?: ReadonlyArray<PlannedBuildStep> }
    | undefined;
  const step = features?.buildSteps?.find((candidate) => candidate.id === "service-lando.php:mailpit");
  if (step === undefined) throw new Error("no mailpit build step on the selected service");
  return step;
};

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
    const selected = new Set<string>(expected);
    for (const service of Object.values(result.services)) {
      if (selected.has(String(service.name))) continue;
      expect(JSON.stringify(service.extensions)).not.toContain("sendmail_path");
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

  test("installs msmtp from a pinned snapshot source rather than the live archive", async () => {
    // Given / When
    const result = await plan(undefined);
    const step = msmtpStep(plannedService(result, "first"));
    // Then
    expect(step.command).not.toMatch(/install -y --no-install-recommends msmtp(?!=)/u);
    expect(step.command).toContain("https://snapshot.debian.org/archive/debian/");
    expect(step.command).toContain(" bookworm main");
    expect(step.command).toContain("-o Dir::Etc::SourceParts=-");
    expect(step.command).toContain("msmtp=1.8.23-1");
    expect(step.command).toContain('sendmail_path = "/usr/bin/msmtp --host=mail --port=1025');
    expect(step.buildKeyInputs).toMatchObject({
      mailpit: { host: "mail", port: 1025 },
      msmtp: { family: "debian-bookworm", suite: "bookworm", version: "1.8.23-1" },
    });
    expect(step.buildKeyInputs?.msmtp).not.toHaveProperty("families");
  });

  test("pins a custom bullseye-tagged PHP image to the bullseye family", async () => {
    // Given / When
    const result = await plan(["first"], true, { image: "php:8.3-cli-bullseye", home: false });
    const step = msmtpStep(plannedService(result, "first"));
    // Then
    expect(step.command).toContain(" bullseye main");
    expect(step.command).toContain("msmtp=1.8.11-2.1");
    expect(step.command).not.toContain("bookworm");
    expect(step.buildKeyInputs).toMatchObject({ msmtp: { family: "debian-bullseye" } });
  });

  test("fails planning closed when a selected PHP image has no provable base family", async () => {
    // Given / When
    const result = await Effect.runPromise(
      Effect.either(planEffect(undefined, true, { image: "my-registry.example/php:8.3", home: false })),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "LandofileValidationError" } });
    if (result._tag !== "Left") return;
    expect(result.left.message).toContain("first");
    expect(result.left.message).toContain("my-registry.example/php:8.3");
  });

  test("an unprovable image still plans when mailFrom excludes it", async () => {
    // Given / When
    const result = await plan(["second"], true, { image: "my-registry.example/php:8.3", home: false });
    // Then
    expect(msmtpStep(plannedService(result, "second")).command).toContain("msmtp=1.8.23-1");
    expect(JSON.stringify(plannedService(result, "first").extensions)).not.toContain("sendmail_path");
  });

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
