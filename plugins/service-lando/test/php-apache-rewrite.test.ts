import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { ServiceBuildDirectoryCommand } from "@lando/sdk/services";

import { php83ServiceType } from "../src/services/php.ts";
import { apacheLauncherDirectives } from "./support/apache-directives.ts";
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
    { name: "unlabelled service", config: {} },
    { name: "Backdrop", config: { framework: "backdrop" } },
    { name: "another framework", config: { framework: "drupal" } },
    { name: "non-root custom port", config: { user: "www-data", home: false, port: 8080 } },
    { name: "planner-stamped stock image", config: { image: "php:8.3-apache-bookworm" } },
  ])("passes configured Backdrop settings by name for $name", async ({ config }) => {
    // Given: credentials stay in the configured process environment.
    const settings = JSON.stringify({ database: "issue1077", password: "secret-'$\\\"" });
    // When: compose the stock Apache launcher.
    const { plan, steps } = await planPhp({
      ...config,
      environment: { BACKDROP_SETTINGS: settings, PRIVATE_OTHER: "unrelated-secret" },
    });
    // Then: only the variable name crosses into Apache request configuration.
    expect(
      apacheLauncherDirectives(plan.command, "apache2-foreground").filter((directive) =>
        directive.startsWith("PassEnv "),
      ),
    ).toEqual(["PassEnv BACKDROP_SETTINGS"]);
    expect(plan.environment?.BACKDROP_SETTINGS).toBe(settings);
    expect(JSON.stringify({ command: plan.command, steps })).not.toContain("issue1077");
    expect(JSON.stringify({ command: plan.command, steps })).not.toContain("unrelated-secret");
  });

  test.each([{}, { environment: { PRIVATE_OTHER: "secret" } }])(
    "does not forward environment when Backdrop settings are absent: %j",
    async (config) => {
      // Given / When: compose Apache without BACKDROP_SETTINGS.
      const { plan } = await planPhp(config);
      // Then: no environment is exposed through PassEnv.
      expect(
        apacheLauncherDirectives(plan.command, "apache2-foreground").some((directive) =>
          directive.startsWith("PassEnv "),
        ),
      ).toBe(false);
    },
  );

  test("passes an explicitly empty Backdrop settings variable", async () => {
    // Given / When: an empty value is still configured in the environment.
    const { plan } = await planPhp({ environment: { BACKDROP_SETTINGS: "" } });
    // Then: Apache inherits it by name, not by truthiness of its value.
    expect(apacheLauncherDirectives(plan.command, "apache2-foreground")).toContain(
      "PassEnv BACKDROP_SETTINGS",
    );
  });

  test.each([
    { name: "FPM", config: { via: "fpm" } },
    { name: "CLI", config: { via: "cli" } },
    { name: "custom image", config: { image: "example/php:custom" } },
    { name: "authored command", config: { command: ["apache2-foreground"] } },
    { name: "authored entrypoint", config: { entrypoint: ["/custom-start"] } },
  ])("leaves environment handoff to the owner for $name", async ({ config }) => {
    // Given / When: compose a process Lando does not own.
    const { plan } = await planPhp({ ...config, environment: { BACKDROP_SETTINGS: "{}" } });
    // Then: do not inject Apache directives into its command.
    expect(JSON.stringify(plan.command) ?? "").not.toContain("PassEnv");
  });

  test("enables mod_env at stock Apache image build time", async () => {
    // Given / When: compose the stock Apache image.
    const { steps } = await planPhp({ environment: { BACKDROP_SETTINGS: "{}" } });
    // Then: PassEnv's module is explicitly enabled as privileged build work.
    expect(steps.filter((step) => /a2enmod\b[^\n]*\benv\b/u.test(commandText(step.command)))).toMatchObject([
      { phase: "build", user: "root" },
    ]);
  });

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
