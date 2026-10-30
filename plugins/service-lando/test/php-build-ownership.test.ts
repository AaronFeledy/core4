import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import { resolvePhpRuntimePolicy } from "../src/services/php-runtime-policy.ts";
import { resolvePhpVia } from "../src/services/php-via.ts";
import { php83ServiceType } from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const config = (input: Readonly<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", ...input });
const Steps = Schema.Struct({
  buildSteps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
const compose = (service: ServiceConfig) =>
  composeServicePlan({
    serviceType: php83ServiceType,
    service,
    appRoot: "/srv/apps/php-ownership",
    appName: "php-ownership",
    serviceName: "web",
    metadata: { resolvedAt: "2026-10-28T00:00:00Z", source: "php-ownership", runtime: 4 },
  });

describe("PHP replacement build ownership", () => {
  test.each([undefined, "php:8.3-apache-bookworm", "php:8.3-cli-bullseye"])(
    "refuses to infer a Dockerfile OS from image %s",
    (image) => {
      // Given / When: the build may replace every layer of a canonical tagged image.
      const service = config({ build: { context: "." }, ...(image === undefined ? {} : { image }) });
      // Then: mail wiring cannot select a Debian package family from that tag.
      expect(resolvePhpRuntimePolicy(service, "8.3", "apache").baseFamily).toEqual({
        kind: "unknown",
        reason: "replacement-build",
      });
    },
  );

  test.each([
    { context: "." },
    "./php",
    { dockerfile: "Dockerfile.php" },
    { dockerfile_inline: "FROM alpine:3.22" },
  ])("classifies decoded build %j before checking image", (build) => {
    // Given: both direct composition and the planner's synthetic catalog image.
    const services = [config({ build }), config({ build, image: "php:8.3-apache-bookworm" })];
    // When / Then: replacement builds own their runtime and prove no Debian family.
    for (const service of services) {
      const policy = resolvePhpRuntimePolicy(service, "8.3", "apache");
      expect(policy.artifactSource).toBe("context-build");
      expect(policy.reference).toBeUndefined();
      expect(policy.baseFamily).toEqual({ kind: "unknown", reason: "replacement-build" });
    }
  });

  test.each(["apache", "fpm", "cli"])("retains stock classification for catalog-stamped %s", (via) => {
    // Given / When: the catalog stamps its Apache tag even for another serving mode.
    const service = config({ via, image: "php:8.3-apache-bookworm" });
    // Then: the serving-mode image selection still belongs to Lando.
    const policy = resolvePhpRuntimePolicy(service, "8.3", resolvePhpVia(via));
    expect(policy.artifactSource).toBe("stock");
    expect(policy.baseFamily).toMatchObject({ kind: "known", family: "debian-bookworm" });
  });

  test.each([{ artifact: ["echo artifact"] }, { app: ["echo app"] }])(
    "retains stock setup for additive scripts %j",
    async (build) => {
      // Given / When: additive scripts extend, rather than replace, the stock image.
      const service = config({ build, image: "php:8.3-apache-bookworm" });
      const plan = await compose(service);
      // Then: stock prerequisites and the launcher remain available.
      const policy = resolvePhpRuntimePolicy(service, "8.3", "apache");
      expect(policy.artifactSource).toBe("stock");
      expect(policy.baseFamily).toMatchObject({ kind: "known", family: "debian-bookworm" });
      expect(
        Schema.decodeUnknownSync(Steps)(plan.extensions["@lando/core/service-features"]).buildSteps,
      ).toContainEqual(expect.objectContaining({ id: "service-lando.php:prerequisites" }));
      expect(plan.command?.slice(0, 2)).toEqual(["sh", "-c"]);
    },
  );

  test.each(["apache", "fpm", "cli"])(
    "skips implicit installations and launcher for contextual %s",
    async (via) => {
      // Given: a WordPress build with explicit debug settings, packages, and a synthetic image.
      const service = config({
        via,
        build: { context: "." },
        image: "php:8.3-apache-bookworm",
        framework: "wordpress",
        xdebug: true,
        composer: { packages: { "drush/drush": "^13.0" } },
      });
      // When: run the real service composer and resolution.
      const plan = await compose(service);
      const resolution = await Effect.runPromise(
        php83ServiceType.resolve({
          name: "web",
          service,
          appRoot: "/srv/apps/php-ownership",
          metadata: { resolvedAt: "2026-10-28T00:00:00Z", source: "php-ownership", runtime: 4 },
        }),
      );
      // Then: author-requested features survive without stock binary/extension installs.
      const steps = Schema.decodeUnknownSync(Steps)(
        plan.extensions["@lando/core/service-features"],
      ).buildSteps;
      expect(steps.filter(({ id }) => id.startsWith("service-lando.php:"))).toEqual([
        { id: "service-lando.php:composer-packages" },
      ]);
      expect(plan.command).toBeUndefined();
      expect(plan.environment.WP_CLI_ALLOW_ROOT).toBeUndefined();
      expect(plan.environment.XDEBUG_CONFIG).toContain("client_port=9003");
      expect(resolution.tooling?.xdebug).toBeDefined();
    },
  );
});
