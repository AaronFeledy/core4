import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppliedStateInventory, ProviderId } from "@lando/sdk/schema";
import { PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";

import { plan, registryLayer } from "./fixtures/error-registry.ts";

const providerId = ProviderId.make("test");
const inventory = (selected = providerId) =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    return yield* registry.appliedStateInventory(selected);
  });

test("strict inventory preserves all roots and unreadable ownership without constructing a provider", async () => {
  const expected: AppliedStateInventory = {
    plans: [plan, { ...plan, id: AppId.make("other-app"), root: AbsolutePath.make("/tmp/other-app") }],
    unreadable: [
      {
        path: "/tmp/applied/aggregate.json",
        reason: "newer-version",
        storedVersion: 11,
        supportedVersion: 10,
      },
      { path: "/tmp/applied/protected.json", appId: AppId.make("protected"), reason: "unreadable" },
    ],
  };
  const result = await Effect.runPromise(
    inventory().pipe(
      Effect.provide(
        registryLayer(TestRuntimeProvider, {
          contribution: {
            make: () => Effect.die("Strict inventory must not construct a runtime"),
            appliedStateInventory: () =>
              Effect.gen(function* () {
                const paths = yield* PathsService;
                expect(paths.roots.userDataRoot).toStartWith("/tmp/error-boundary-");
                return expected;
              }),
          },
        }),
      ),
    ),
  );
  expect(result).toBe(expected);
  expect(result.plans).toHaveLength(2);
  expect(result.unreadable).toEqual(expected.unreadable);
});

test("an installed third-party provider without strict inventory fails instead of reporting no claims", async () => {
  const result = await Effect.runPromise(
    inventory().pipe(
      Effect.provide(
        registryLayer(TestRuntimeProvider, {
          contribution: {
            make: () => Effect.die("Missing strict inventory must not construct a runtime"),
            ...Object.fromEntries([["appliedStateInventory", undefined]]),
          },
        }),
      ),
      Effect.result,
    ),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProviderUnavailableError",
      providerId: "test",
      operation: "load-contribution",
    },
  });
  if (result._tag === "Failure") expect(result.failure.remediation).toContain("appliedStateInventory");
});

test("an unknown provider fails without reading another installed provider's inventory", async () => {
  const result = await Effect.runPromise(
    inventory(ProviderId.make("missing")).pipe(
      Effect.provide(
        registryLayer(TestRuntimeProvider, {
          contribution: {
            make: () => Effect.die("Unknown provider must not construct another runtime"),
            appliedStateInventory: () => Effect.die("Unknown provider must not read another inventory"),
          },
        }),
      ),
      Effect.result,
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "NoProviderInstalledError" } });
});

test("strict inventory failures retain the selected provider and operation", async () => {
  const failure = new ProviderUnavailableError({
    providerId: "test",
    operation: "applied-state.list",
    message: "Cannot inspect inventory directory.",
    remediation: "Repair the directory permissions before continuing.",
  });
  const result = await Effect.runPromise(
    inventory().pipe(
      Effect.provide(
        registryLayer(TestRuntimeProvider, {
          contribution: {
            make: () => Effect.die("Inventory errors must not construct a runtime"),
            appliedStateInventory: () => Effect.fail(failure),
          },
        }),
      ),
      Effect.result,
    ),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProviderUnavailableError",
      providerId: "test",
      operation: "applied-state.list",
      message: failure.message,
      remediation: failure.remediation,
    },
  });
});
