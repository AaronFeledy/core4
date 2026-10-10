import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { ServiceBuildDirectoryCommand } from "@lando/sdk/services";

import { php83ServiceType } from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const BuildSteps = Schema.Struct({
  buildSteps: Schema.Array(
    Schema.Struct({
      phase: Schema.String,
      user: Schema.optionalKey(Schema.String),
      command: Schema.Union([Schema.String, Schema.Array(Schema.String), ServiceBuildDirectoryCommand]),
    }),
  ),
});

const commandText = (command: (typeof BuildSteps.Type.buildSteps)[number]["command"]): string => {
  if (typeof command === "string") return command;
  return "directories" in command ? "" : command.join(" ");
};

const planPhp = async (config: Readonly<Record<string, unknown>>) => {
  const service = Schema.decodeUnknownSync(LandofileShape)({
    name: "rewrite-test",
    services: { web: { type: "php:8.3", ...config } },
  }).services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  const plan = await composeServicePlan({
    serviceType: php83ServiceType,
    service,
    appRoot: "/srv/apps/rewrite-test",
    appName: "rewrite-test",
    serviceName: "web",
    metadata: { resolvedAt: "2026-10-09T00:00:00Z", source: "rewrite-test", runtime: 4 },
  });
  return {
    plan,
    steps: Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]).buildSteps,
  };
};

describe("PHP Apache rewrite setup", () => {
  test.each([
    { name: "default Apache", config: {} },
    { name: "explicit Apache", config: { via: "apache" } },
    { name: "htaccess app", config: { allowOverride: true, webroot: "/app/public" } },
    { name: "non-root service user", config: { user: "www-data", home: false } },
    { name: "planner-stamped stock image", config: { image: "php:8.3-apache-bookworm" } },
  ])("enables rewrite at image build time for $name", async ({ config }) => {
    // Given / When: compose the stock PHP service as the planner does.
    const { plan, steps } = await planPhp(config);

    // Then: module setup is privileged build work, never a startup write.
    const rewriteSteps = steps.filter((step) => commandText(step.command).includes("a2enmod rewrite"));
    expect(rewriteSteps).toHaveLength(1);
    expect(rewriteSteps[0]).toMatchObject({ phase: "build", user: "root" });
    expect(typeof plan.command === "string" ? plan.command : plan.command?.join(" ")).not.toContain(
      "a2enmod",
    );
  });

  test.each([
    { name: "FPM", config: { via: "fpm" } },
    { name: "CLI", config: { via: "cli" } },
    { name: "custom Apache image", config: { image: "example/php:custom" } },
    { name: "authored command", config: { command: ["apache2-foreground"] } },
    { name: "authored entrypoint", config: { entrypoint: ["/custom-start"] } },
  ])("leaves Apache module setup to the owner for $name", async ({ config }) => {
    // Given / When: compose a mode or image whose Apache setup Lando does not own.
    const { steps } = await planPhp(config);

    // Then: no Apache module command can run on those images.
    expect(steps.some((step) => commandText(step.command).includes("a2enmod"))).toBe(false);
  });
});
