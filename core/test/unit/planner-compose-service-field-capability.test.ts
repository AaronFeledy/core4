import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { CapabilityError } from "@lando/core/errors";
import { LandofileShape, type ProviderCapabilities, ServiceName } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as AppPlannerLayer from "@lando/engine/services/planner";

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

import { literalLandofile } from "../_support/value-contracts.ts";

const planExit = (landofile: typeof LandofileShape.Type, capabilities: ProviderCapabilities) =>
  Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(literalLandofile(landofile, process.cwd()), capabilities),
    ).pipe(Effect.provide(AppPlannerLayer.layer), Effect.provide(PluginRegistryLayer.layer)),
  );

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected planning to fail");
  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) throw new Error("Expected a typed planning failure");
  return failure.value;
};

describe("Compose service field capabilities", () => {
  test("allows normalized networks without Compose service field support", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "allowed-network",
      runtime: 4,
      networks: { frontend: {} },
      services: { web: { image: "node:lts", home: false, networks: ["frontend"] } },
    });
    await withTempCwd(async () => {
      const exit = await planExit(landofile, {
        ...TestRuntimeProvider.capabilities,
        composeServiceFields: { supported: [] },
      });
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit))
        expect(exit.value.networking?.authoredNetworks?.[0]).toMatchObject({
          key: "frontend",
          external: false,
        });
    });
  });
  test.each([false, true])(
    "Given a provider omitting authoredNetworks, when networks is planned (aliases=%s), then planning fails closed",
    async (aliases) => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "network-field",
        runtime: 4,
        ...(aliases ? {} : { networks: { frontend: {} } }),
        services: {
          web: {
            image: "node:lts",
            home: false,
            networks: aliases ? { default: { aliases: ["api"] } } : ["frontend"],
          },
        },
      });

      await withTempCwd(async () => {
        // When
        const { authoredNetworks: _authoredNetworks, ...capabilities } = TestRuntimeProvider.capabilities;
        const unsupported = {
          ...capabilities,
          composeServiceFields: { supported: ["configs"] as const },
          composeProjectFields: { supported: ["configs"] as const },
        };
        const exit = await planExit(landofile, unsupported);

        // Then
        const failure = expectFailure(exit);
        expect(failure).toBeInstanceOf(CapabilityError);
        expect(failure).toMatchObject({
          _tag: "CapabilityError",
          key: "networks",
          feature: "authored networks",
          capability: "authoredNetworks",
          providerId: "lando",
        });
        expect(failure instanceof CapabilityError ? (failure.remediation?.length ?? 0) : 0).toBeGreaterThan(
          0,
        );
      });
    },
  );

  test("Given labels and an undeclaring provider, when planning, then planning fails closed", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "labels-field",
      runtime: 4,
      services: { web: { image: "node:lts", home: false, labels: { "example.com/role": "web" } } },
    });

    await withTempCwd(async () => {
      // When
      const unsupported = {
        ...TestRuntimeProvider.capabilities,
        composeServiceFields: { supported: ["configs"] as const },
      };
      const exit = await planExit(landofile, unsupported);

      // Then
      expect(expectFailure(exit)).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        key: "labels",
        feature: "compose service field labels",
        capability: "composeSpec",
        providerId: "lando",
      });
    });
  });

  test("Given labels declared below native tier, when planning, then planning fails closed", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "portable-label-field",
      runtime: 4,
      services: { web: { image: "node:lts", home: false, labels: { "example.com/role": "web" } } },
    });
    const capabilities: ProviderCapabilities = {
      ...TestRuntimeProvider.capabilities,
      composeSpec: "portable",
      composeServiceFields: { supported: ["labels"] },
    };

    await withTempCwd(async () => {
      // When
      const exit = await planExit(landofile, capabilities);

      // Then
      expect(expectFailure(exit)).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        key: "labels",
        capability: "composeSpec",
        providerId: "lando",
      });
    });
  });

  test("Given an authored x-prefixed key, when capability support is omitted, then planning preserves it", async () => {
    const extension = { nested: [1, "two", { enabled: true }] } as const;
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "inert-extension-field",
      runtime: 4,
      services: { web: { image: "node:lts", home: false, "x-foo": extension } },
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
