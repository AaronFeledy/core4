import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { CapabilityError } from "@lando/core/errors";
import { LandofileShape, type ProviderCapabilities, ServiceName } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { PluginRegistryLive } from "../../src/testing/engine-layers.ts";
import { AppPlannerLive } from "../../src/testing/engine-layers.ts";

const supportedCapabilities: ProviderCapabilities = {
  ...TestRuntimeProvider.capabilities,
  composePreservedPaths: {
    supported: ["depends_on.*.restart", "healthcheck.start_interval"],
  },
};

const withTempCwd = async <A>(run: () => Promise<A>): Promise<A> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-path-capability-")));
  const previousCwd = process.cwd();
  try {
    process.chdir(directory);
    return await run();
  } finally {
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
};

const planExit = (landofile: typeof LandofileShape.Type, capabilities: ProviderCapabilities) =>
  Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected planning to fail");
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) throw new Error("Expected a typed planning failure");
  return failure.value;
};

const landofileWithBothPaths = () =>
  Schema.decodeUnknownSync(LandofileShape)({
    name: "preserved-paths",
    runtime: 4,
    services: {
      database: { image: "postgres:17" },
      web: {
        image: "node:lts",
        depends_on: {
          database: { condition: "service_started", restart: true },
        },
        healthcheck: { test: ["CMD", "true"], start_interval: "5s" },
      },
    },
  });

describe("Compose preserved path capabilities", () => {
  test("preserves both exact paths when the provider declares support", async () => {
    await withTempCwd(async () => {
      const exit = await planExit(landofileWithBothPaths(), supportedCapabilities);

      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.services[ServiceName.make("web")]?.extensions.compose).toMatchObject({
          depends_on: { database: { restart: true } },
          healthcheck: { start_interval: "5s" },
        });
      }
    });
  });

  test("fails closed on depends_on restart when exact support is omitted", async () => {
    await withTempCwd(async () => {
      const exit = await planExit(landofileWithBothPaths(), TestRuntimeProvider.capabilities);

      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      expect(failure).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        key: "depends_on.*.restart",
        feature: "compose preserved path depends_on.*.restart",
        capability: "composeSpec",
        providerId: "lando",
      });
      if (!(failure instanceof CapabilityError)) throw new Error("Expected a CapabilityError");
      expect(failure.remediation?.length ?? 0).toBeGreaterThan(0);
    });
  });

  test("fails closed on healthcheck start_interval when only dependency restart is declared", async () => {
    const capabilities: ProviderCapabilities = {
      ...TestRuntimeProvider.capabilities,
      composePreservedPaths: { supported: ["depends_on.*.restart"] },
    };

    await withTempCwd(async () => {
      const exit = await planExit(landofileWithBothPaths(), capabilities);

      expect(expectFailure(exit)).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        key: "healthcheck.start_interval",
        feature: "compose preserved path healthcheck.start_interval",
        capability: "composeSpec",
        providerId: "lando",
      });
    });
  });

  test("keeps service x-* metadata inert when exact-path support is omitted", async () => {
    const extension = { nested: [1, "two", { enabled: true }] } as const;
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "inert-service-extension",
      runtime: 4,
      services: { web: { image: "node:lts", "x-foo": extension } },
    });

    await withTempCwd(async () => {
      const exit = await planExit(landofile, TestRuntimeProvider.capabilities);

      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.services[ServiceName.make("web")]?.extensions.compose).toEqual({
          "x-foo": extension,
        });
      }
    });
  });
});
