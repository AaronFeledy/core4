import { expect, test } from "bun:test";
import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { buildKeyForService } from "../../src/services/build-key.ts";

/**
 * Catalog package installs (`node.globals`, PHP `composer.packages`) carry
 * their normalized list on the build step's `buildKeyInputs`, so the artifact
 * key follows the packages without any package-specific hashing in the engine.
 */
type PackageStep = {
  readonly id: string;
  readonly phase: string;
  readonly command: string;
  readonly user?: string;
  readonly buildKeyInputs: Readonly<Record<string, unknown>>;
};

const key = (buildSteps: ReadonlyArray<PackageStep>) => {
  const service: ServicePlan = {
    name: ServiceName.make("web"),
    type: "node:22",
    provider: ProviderId.make("test"),
    primary: true,
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata: {
      resolvedAt: DateTime.unsafeMake("2026-09-13T00:00:00.000Z"),
      source: "build-key-packages.test",
      runtime: 4,
    },
    extensions: { "@lando/core/service-features": { buildSteps } },
  };
  return Effect.runPromise(buildKeyForService(TestRuntimeProvider, service));
};

const globalsStep = (globals: ReadonlyArray<readonly [string, string]>, user = "root"): PackageStep => ({
  id: "service-lando.node:globals",
  phase: "build",
  command: `set -eux && npm install -g --no-fund --no-audit ${globals
    .map(([name, version]) => `'${name}@${version}'`)
    .join(" ")}`,
  user,
  buildKeyInputs: { globals },
});

const SORTED = [
  ["gulp-cli", "latest"],
  ["yarn", "1.22.4"],
] as const;

test("keeps the artifact key stable for identical normalized package lists", async () => {
  // Given a service whose globals step is regenerated from the same authored
  // packages, when the key is derived twice, then the build is up to date.
  const original = await key([globalsStep(SORTED)]);
  // When
  const rebuilt = await key([globalsStep(SORTED)]);
  // Then
  expect(rebuilt).toBe(original);
});

test("changes the artifact key when a package version changes", async () => {
  // Given
  const original = await key([globalsStep(SORTED)]);
  // When
  const changed = await key([
    globalsStep([
      ["gulp-cli", "latest"],
      ["yarn", "1.22.22"],
    ]),
  ]);
  // Then
  expect(changed).not.toBe(original);
});

test("changes the artifact key when a package is added", async () => {
  // Given
  const original = await key([globalsStep(SORTED)]);
  // When
  const changed = await key([
    globalsStep([
      ["gulp-cli", "latest"],
      ["typescript", "^5.6.0"],
      ["yarn", "1.22.4"],
    ]),
  ]);
  // Then
  expect(changed).not.toBe(original);
});

test("changes the artifact key when the package step runs as a different user", async () => {
  // Given
  const original = await key([globalsStep(SORTED)]);
  // When
  const changed = await key([globalsStep(SORTED, "node")]);
  // Then
  expect(changed).not.toBe(original);
});

test("changes the artifact key when composer packages are reordered in the hashed list", async () => {
  // Given a composer package step whose normalized list is the hashed identity,
  // when two lists carry the same packages in a different order,
  // then the keys differ, which is why normalization sorts before hashing.
  const composerStep = (packages: ReadonlyArray<readonly [string, string]>): PackageStep => ({
    id: "service-lando.php:composer-packages",
    phase: "build",
    command: "set -eux && composer global require --no-progress",
    user: "root",
    buildKeyInputs: { packages },
  });
  // When
  const sorted = await key([
    composerStep([
      ["phpstan/phpstan", "^1.11"],
      ["squizlabs/php_codesniffer", "^3.10"],
    ]),
  ]);
  const unsorted = await key([
    composerStep([
      ["squizlabs/php_codesniffer", "^3.10"],
      ["phpstan/phpstan", "^1.11"],
    ]),
  ]);
  // Then
  expect(unsorted).not.toBe(sorted);
});
