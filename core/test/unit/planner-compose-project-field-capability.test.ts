import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { CapabilityError } from "@lando/core/errors";
import { LandofileShape, type ProviderCapabilities } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import { AppPlannerLive } from "@lando/engine/services/planner";

const withTempCwd = async <A>(run: () => Promise<A>): Promise<A> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-project-field-")));
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

describe("Compose project field capabilities", () => {
  test("Given declared project fields, when planning, then configs and secrets are preserved losslessly", async () => {
    // Given
    const configs = { app: { file: "./app.conf", name: "runtime-app" } } as const;
    const secrets = { token: { environment: "APP_TOKEN", name: "runtime-token" } } as const;
    const extension = { nested: [1, "two", { enabled: true }] } as const;
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "project-fields",
      runtime: 4,
      configs,
      secrets,
      "x-project": extension,
      services: { web: { image: "node:lts" } },
    });
    const capabilities = {
      ...TestRuntimeProvider.capabilities,
      composeProjectFields: { supported: ["configs", "secrets"] },
    } satisfies ProviderCapabilities;

    await withTempCwd(async () => {
      // When
      const exit = await planExit(landofile, capabilities);

      // Then
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.extensions.compose).toEqual({ configs, secrets, "x-project": extension });
      }
    });
  });

  test.each(["configs", "secrets"] as const)(
    "Given an undeclared %s project field, when planning, then planning fails closed",
    async (field) => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: `${field}-field`,
        runtime: 4,
        [field]: { app: { file: `./${field}.txt` } },
        services: { web: { image: "node:lts" } },
      });

      await withTempCwd(async () => {
        // When
        const exit = await planExit(landofile, TestRuntimeProvider.capabilities);

        // Then
        const failure = expectFailure(exit);
        expect(failure).toBeInstanceOf(CapabilityError);
        expect(failure).toMatchObject({
          _tag: "CapabilityError",
          key: field,
          feature: `compose project field ${field}`,
          capability: "composeSpec",
          providerId: "lando",
        });
        if (!(failure instanceof CapabilityError)) throw new Error("Expected a CapabilityError");
        expect(failure.remediation?.length ?? 0).toBeGreaterThan(0);
      });
    },
  );

  test("Given only a top-level x-prefixed key, when support is omitted, then planning preserves it inertly", async () => {
    // Given
    const extension = { nested: { enabled: true } } as const;
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "project-extension",
      runtime: 4,
      "x-project": extension,
      services: { web: { image: "node:lts" } },
    });

    await withTempCwd(async () => {
      // When
      const exit = await planExit(landofile, TestRuntimeProvider.capabilities);

      // Then
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.extensions.compose).toEqual({ "x-project": extension });
      }
    });
  });
});
