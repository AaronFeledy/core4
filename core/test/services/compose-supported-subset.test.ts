import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";

import { CapabilityError, LandofileValidationError } from "@lando/core/errors";
import { type LandofileShape, type ProviderCapabilities, ServiceName } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { loadLandofileFile } from "../../src/landofile/service.ts";
import { makePluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const nativeCapabilities: ProviderCapabilities = {
  ...TestRuntimeProvider.capabilities,
  composeSpec: "native",
};

const registryLayer = makePluginRegistryLive({ app: false, user: false });

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-supported-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const loadYamlExit = async (dir: string, content: string) => {
  const source = join(dir, ".lando.yml");
  await writeFile(source, content);
  return { source, exit: await Effect.runPromiseExit(loadLandofileFile(source)) };
};

const planExit = (
  landofile: LandofileShape,
  capabilities: ProviderCapabilities,
  layer = AppPlannerLive.pipe(Layer.provide(registryLayer)),
) =>
  Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
      Effect.provide(layer),
    ),
  );

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

const probeYaml = [
  "name: probe",
  "services:",
  "  entry:",
  "    image: nginx",
  "    networks:",
  "      - mynetwork",
  "    configs:",
  "      - source: test_config",
  "        target: /volumes/test_config.txt",
  "    secrets:",
  "      - source: test_secret",
  "        target: /volumes/test_secret.txt",
  "    profiles: [dev]",
  "    x-custom:",
  "      any: value",
  "",
].join("\n");

describe("Compose supported service subset", () => {
  test("production loading and planning preserve every supported value", async () => {
    await withTempDir(async (dir) => {
      // Given
      const loaded = await loadYamlExit(dir, probeYaml);
      expect(Exit.isSuccess(loaded.exit)).toBe(true);
      if (!Exit.isSuccess(loaded.exit)) return;

      // When
      const planned = await planExit(loaded.exit.value, nativeCapabilities);

      // Then
      expect(Exit.isSuccess(planned)).toBe(true);
      if (!Exit.isSuccess(planned)) return;
      expect(planned.value.services[ServiceName.make("entry")]?.extensions.compose).toEqual({
        networks: ["mynetwork"],
        configs: [{ source: "test_config", target: "/volumes/test_config.txt" }],
        secrets: [{ source: "test_secret", target: "/volumes/test_secret.txt" }],
        profiles: ["dev"],
        "x-custom": { any: "value" },
      });
    });
  });

  test.each([
    { key: "networks", yaml: ["    networks: [mynetwork]"] },
    { key: "configs", yaml: ["    configs: [test_config]"] },
    { key: "secrets", yaml: ["    secrets: [test_secret]"] },
    { key: "profiles", yaml: ["    profiles: [dev]"] },
    { key: "labels", yaml: ["    labels: [io.lando.role=appserver]"] },
    { key: "x-custom", yaml: ["    x-custom:", "      any: value"] },
  ] as const)("requires native composeSpec for $key", async ({ key, yaml }) => {
    await withTempDir(async (dir) => {
      // Given
      const loaded = await loadYamlExit(
        dir,
        ["name: probe", "services:", "  entry:", "    image: nginx", ...yaml, ""].join("\n"),
      );
      expect(Exit.isSuccess(loaded.exit)).toBe(true);
      if (!Exit.isSuccess(loaded.exit)) return;

      // When
      const planned = await planExit(loaded.exit.value, {
        ...nativeCapabilities,
        composeSpec: "portable",
      });

      // Then
      expect(failureOf(planned)).toMatchObject({
        _tag: "CapabilityError",
        service: "entry",
        key,
        capability: "composeSpec",
      });
    });
  });

  test("a cached native plan cannot bypass the composeSpec tier gate", async () => {
    await withTempDir(async (dir) => {
      // Given
      const loaded = await loadYamlExit(dir, probeYaml);
      expect(Exit.isSuccess(loaded.exit)).toBe(true);
      if (!Exit.isSuccess(loaded.exit)) return;
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-cache-")));
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      const cachedLayer = AppPlannerLive.pipe(
        Layer.provide(Layer.mergeAll(CacheServiceLive, FileSystemLive, registryLayer)),
      );

      try {
        const first = await planExit(loaded.exit.value, nativeCapabilities, cachedLayer);
        const second = await planExit(loaded.exit.value, nativeCapabilities, cachedLayer);
        expect(Exit.isSuccess(first) && Exit.isSuccess(second)).toBe(true);
        if (Exit.isSuccess(first) && Exit.isSuccess(second)) {
          expect(second.value.metadata.resolvedAt).toEqual(first.value.metadata.resolvedAt);
        }

        // When
        const restricted = await planExit(
          loaded.exit.value,
          { ...nativeCapabilities, composeSpec: "portable" },
          cachedLayer,
        );

        // Then
        expect(failureOf(restricted)).toMatchObject({
          _tag: "CapabilityError",
          service: "entry",
          key: "configs",
          capability: "composeSpec",
        });
      } finally {
        if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
        else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
        await rm(cacheRoot, { recursive: true, force: true });
      }
    });
  });

  test("a non-x unknown service key remains a strict validation error", async () => {
    await withTempDir(async (dir) => {
      // Given / When
      const loaded = await loadYamlExit(
        dir,
        [
          "name: probe",
          "services:",
          "  entry:",
          "    image: nginx",
          "    unsupported_service_key: true",
          "",
        ].join("\n"),
      );

      // Then
      expect(failureOf(loaded.exit)).toBeInstanceOf(LandofileValidationError);
    });
  });

  test("the native-only tier uses the standard CapabilityError contract", async () => {
    await withTempDir(async (dir) => {
      // Given
      const loaded = await loadYamlExit(
        dir,
        ["name: probe", "services:", "  entry:", "    image: nginx", "    profiles: [dev]", ""].join("\n"),
      );
      expect(Exit.isSuccess(loaded.exit)).toBe(true);
      if (!Exit.isSuccess(loaded.exit)) return;

      // When
      const planned = await planExit(loaded.exit.value, {
        ...nativeCapabilities,
        composeSpec: "none",
      });

      // Then
      const failure = failureOf(planned);
      expect(failure).toBeInstanceOf(CapabilityError);
      expect(failure).toMatchObject({
        _tag: "CapabilityError",
        service: "entry",
        key: "profiles",
        feature: "compose field profiles",
        capability: "composeSpec",
        providerId: "lando",
      });
      expect(failure instanceof CapabilityError ? failure.remediation : undefined).toContain("profiles");
    });
  });
});
