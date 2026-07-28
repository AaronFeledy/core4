import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { CapabilityError } from "@lando/core/errors";
import { LandofileShape, type ProviderCapabilities } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const withTempCwd = async <A>(run: () => Promise<A>): Promise<A> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-field-capability-")));
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

describe("Compose service field capabilities", () => {
  test("Given a provider omitting service-field capabilities, when networks is planned, then planning fails closed", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "network-field",
      runtime: 4,
      services: { web: { image: "node:lts", networks: ["frontend"] } },
    });

    await withTempCwd(async () => {
      // When
      const exit = await planExit(landofile, TestRuntimeProvider.capabilities);

      // Then
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      expect(failure).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        key: "networks",
        feature: "compose service field networks",
        capability: "composeSpec",
        providerId: "lando",
      });
      expect(failure instanceof CapabilityError ? (failure.remediation?.length ?? 0) : 0).toBeGreaterThan(0);
    });
  });

  test("Given an authored x-prefixed key, when support is omitted, then the actual key is reported", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "extension-field",
      runtime: 4,
      services: { web: { image: "node:lts", "x-foo": { enabled: true } } },
    });

    await withTempCwd(async () => {
      // When
      const exit = await planExit(landofile, TestRuntimeProvider.capabilities);

      // Then
      expect(expectFailure(exit)).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        key: "x-foo",
        feature: "compose service field x-foo",
        capability: "composeSpec",
        providerId: "lando",
      });
    });
  });

  test("Given a portable provider declaring x-prefixed support, when x-foo is planned, then planning succeeds", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "portable-extension-field",
      runtime: 4,
      services: { web: { image: "node:lts", "x-foo": { enabled: true } } },
    });
    const capabilities: ProviderCapabilities = {
      ...TestRuntimeProvider.capabilities,
      composeSpec: "portable",
      composeServiceFields: { supported: ["x-*"] },
    };

    await withTempCwd(async () => {
      // When
      const exit = await planExit(landofile, capabilities);

      // Then
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });
});
