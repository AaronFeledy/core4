import { expect, test } from "bun:test";
import { composeService } from "@lando/engine/services/feature";
import { ProviderId, ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import {
  PHP_RUNTIME_POLICY_KEY,
  PhpRuntimePolicy,
  resolvePhpRuntimePolicy,
} from "../src/services/php-runtime-policy.ts";
import { type PhpVia, phpImageFor, resolvePhpVia } from "../src/services/php-via.ts";
import { PHP_FEATURE_ID, phpServiceFeature } from "../src/services/php.ts";
import { phpResolution } from "./support/php-resolution.ts";

test.each([
  { input: {}, source: "stock", authority: "lando", logMode: "apache-console" },
  { input: { via: "fpm" }, source: "stock", authority: "lando", logMode: "fpm-shared-stderr" },
  { input: { via: "cli" }, source: "stock", authority: "lando", logMode: "console-only" },
  { input: { command: ["php", "-v"] }, source: "stock", authority: "authored", logMode: "console-only" },
  { input: { entrypoint: ["php"] }, source: "stock", authority: "authored", logMode: "console-only" },
  {
    input: { image: "php:8.2-fpm-bullseye" },
    source: "image",
    authority: "image-default",
    logMode: "console-only",
  },
  {
    input: { image: "acme/php:8", command: ["serve"] },
    source: "image",
    authority: "authored",
    logMode: "console-only",
  },
  {
    input: { build: { context: "." } },
    source: "context-build",
    authority: "image-default",
    logMode: "console-only",
  },
  {
    input: { build: { context: "." }, entrypoint: ["serve"] },
    source: "context-build",
    authority: "authored",
    logMode: "console-only",
  },
  {
    input: { build: { artifact: ["echo artifact"], app: ["echo app"] } },
    source: "stock",
    authority: "lando",
    logMode: "apache-console",
  },
])("resolves independent artifact/process ownership for $input", ({ input, source, authority, logMode }) => {
  // Given
  const service = Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", ...input });
  // When
  const resolution = phpResolution(service);
  const policy = resolution.metadata?.[PHP_RUNTIME_POLICY_KEY];
  // Then
  expect(policy).toMatchObject({ artifactSource: source, processAuthority: authority, logMode });
  expect(Object.isFrozen(policy)).toBe(true);
  const parsed = Schema.decodeUnknownSync(PhpRuntimePolicy)(policy);
  expect(
    Object.isFrozen(
      policy !== null && typeof policy === "object" && "baseFamily" in policy ? policy.baseFamily : undefined,
    ),
  ).toBe(true);
  expect(resolution.features.find(({ id }) => id === PHP_FEATURE_ID)?.config?.policy).toBe(policy);
  expect(
    parsed.logMode === "console-only"
      ? resolution.logSources
      : resolution.logSources?.map(({ strategy }) => strategy),
  ).toEqual(logMode === "console-only" ? [] : ["console", "console"]);
});

const aliases = ["php", "docker.io/library/php", "index.docker.io/php", "registry-1.docker.io/library/php"];
for (const via of ["apache", "fpm", "cli"] satisfies readonly PhpVia[]) {
  test.each(aliases)(`preserves the catalog Apache stamp for ${via} through %s`, (repository) => {
    // Given
    const service = Schema.decodeUnknownSync(ServiceConfig)({
      type: "php:8.3",
      via,
      image: `${repository}:8.3-apache-bookworm`,
    });
    // When
    const policy = resolvePhpRuntimePolicy(service, "8.3", via);
    // Then
    expect(policy).toMatchObject({
      artifactSource: "stock",
      reference: phpImageFor("8.3", via),
      baseFamily: { evidence: "stock" },
    });
  });
  test.each(aliases)(
    `proves external bullseye family without claiming ${via} process authority through %s`,
    (repository) => {
      // Given
      const service = Schema.decodeUnknownSync(ServiceConfig)({
        type: "php:8.3",
        via,
        image: `${repository}:8.2-${via}-bullseye`,
      });
      // When
      const policy = resolvePhpRuntimePolicy(service, "8.3", via);
      // Then
      expect(policy).toMatchObject({
        artifactSource: "image",
        processAuthority: "image-default",
        logMode: "console-only",
        baseFamily: { kind: "known", family: "debian-bullseye", evidence: "canonical-reference" },
      });
    },
  );
}

test("PHP application honors feature policy when normalized config suggests the opposite ownership", async () => {
  // Given
  const authored = Schema.decodeUnknownSync(ServiceConfig)({
    type: "php:8.3",
    build: { context: "." },
    xdebug: true,
  });
  const resolution = phpResolution(authored);
  const feature = resolution.features.find(({ id }) => id === PHP_FEATURE_ID);
  if (feature === undefined) throw new Error("missing PHP feature");
  const normalizedConfig = Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", xdebug: true });
  // When
  const plan = await Effect.runPromise(
    composeService({
      appRoot: "/srv/apps/php-policy",
      base: {
        name: ServiceName.make("web"),
        type: "php:8.3",
        provider: ProviderId.make("test"),
        primary: true,
        defaultFeatures: [],
      },
      baseKind: "lando",
      normalizedConfig,
      resolutionMetadata: resolution.metadata,
      features: [{ ...feature, definition: phpServiceFeature }],
    }),
  );
  // Then
  expect(plan.command).toBeUndefined();
  expect(plan.environment.XDEBUG_CONFIG).toContain("client_port=9003");
  expect(plan.extensions["@lando/core/service-features"]).not.toHaveProperty("buildSteps");
});

test.each(["apache", "fpm", "cli"])(
  "authored %s process contributes no implicit aliases while retaining stock installation",
  (via) => {
    // Given
    const service = Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", via, command: ["php", "-v"] });
    // When
    const resolution = phpResolution(service);
    const policy = resolvePhpRuntimePolicy(service, "8.3", resolvePhpVia(via));
    // Then
    expect(resolution.logSources).toEqual([]);
    expect(policy.artifactSource).toBe("stock");
    expect(policy.processAuthority).toBe("authored");
  },
);
