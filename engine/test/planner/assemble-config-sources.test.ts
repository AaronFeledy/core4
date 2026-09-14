import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import { type LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Either } from "effect";
import * as cache from "../../src/cache/app-plan.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const withTempCwd = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-config-plan-")));
  const previous = process.cwd();
  try {
    process.chdir(root);
    await writeFile(join(root, ".lando.yml"), "name: config-test\nruntime: 4\n");
    await writeFile(join(root, "server.conf"), "first\n");
    await mkdir(join(root, "conf"));
    await run(root);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
};

const plan = (config: { readonly server?: string; readonly dir?: string }) => {
  const landofile: LandofileShape = {
    name: "config-test",
    runtime: 4,
    services: { [ServiceName.make("db")]: { type: "compose", image: "postgres:16", home: false, config } },
  };
  return Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(landofile, TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(AppPlannerLive), Effect.provide(PluginRegistryLive));
};

test("changes the derived plan cache key when config bytes change", () =>
  withTempCwd(async (root) => {
    // Given
    const keys = spyOn(cache, "deriveAppPlanCacheKey");
    try {
      await Effect.runPromise(plan({ server: "server.conf" }));
      const original = keys.mock.results.at(-1)?.value;
      expect(typeof original).toBe("string");
      // When
      await writeFile(join(root, "server.conf"), "second\n");
      await Effect.runPromise(plan({ server: "server.conf" }));
      // Then
      expect(keys.mock.results.at(-1)?.value).not.toBe(original);
    } finally {
      keys.mockRestore();
    }
  }));

test("rejects an escaping config source before provider action", () =>
  withTempCwd(async () => {
    // Given
    const start = spyOn(TestRuntimeProvider, "start");
    try {
      // When
      const result = await Effect.runPromise(
        plan({ server: "../outside.conf" }).pipe(
          Effect.tap((app) => TestRuntimeProvider.start({ app: app.id, service: ServiceName.make("db") })),
          Effect.either,
        ),
      );
      // Then
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(LandofileValidationError);
        expect(result.left).toMatchObject({ issues: ["services.db.config.server"] });
      }
      expect(start).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }
  }));

test("carries sorted source identities in the finished service extension", () =>
  withTempCwd(async (root) => {
    // Given
    const config = { server: "server.conf", dir: "conf" };
    // When
    const app = await Effect.runPromise(plan(config));
    // Then
    expect(app.services[ServiceName.make("db")]?.extensions["@lando/core/service-features"]).toMatchObject({
      configSources: [
        {
          key: "dir",
          authored: "conf",
          source: join(root, "conf"),
          digest: createHash("sha256").update("").digest("hex"),
        },
        {
          key: "server",
          authored: "server.conf",
          source: join(root, "server.conf"),
          digest: createHash("sha256").update("first\n").digest("hex"),
        },
      ],
    });
  }));
