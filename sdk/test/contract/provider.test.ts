import { describe, expect, test } from "bun:test";

import { Effect, Stream } from "effect";

import { AppId, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProvider } from "@lando/sdk/services";
import {
  ContractFailure,
  TestRuntimeProvider,
  runProviderContract,
  runProviderContractSuite,
} from "@lando/sdk/test";

const TEST_APP_ID = AppId.make("myapp");
const TEST_SERVICE_NAME = ServiceName.make("web");

describe("RuntimeProvider contract", () => {
  test("exports a runnable Effect contract helper", async () => {
    const contract = runProviderContract(TestRuntimeProvider);

    expect(Effect.isEffect(contract)).toBe(true);
    await expect(Effect.runPromise(contract)).resolves.toBeUndefined();
  });

  test("keeps the original suite export as a runnable alias", async () => {
    const contract = runProviderContractSuite({ providerId: "test", provider: TestRuntimeProvider });

    expect(Effect.isEffect(contract)).toBe(true);
    await expect(Effect.runPromise(contract)).resolves.toBeUndefined();
  });

  test("documents the Phase 1 provider assertions", async () => {
    expect(TestRuntimeProvider.capabilities.serviceExec).toBe(true);
    expect(TestRuntimeProvider.capabilities.serviceLogs).toBe(true);
    expect(Effect.isEffect(TestRuntimeProvider.destroy({ app: TEST_APP_ID }, { volumes: true }))).toBe(true);
    expect(
      Stream.StreamTypeId in
        Object(
          TestRuntimeProvider.execStream(
            { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
            { command: ["echo", "ok"] },
          ),
        ),
    ).toBe(true);
    expect(
      Stream.StreamTypeId in
        Object(TestRuntimeProvider.logs({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { follow: false })),
    ).toBe(true);
    expect(
      Effect.isEffect(TestRuntimeProvider.inspect({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
    ).toBe(true);

    const snapshot = await Effect.runPromise(
      TestRuntimeProvider.inspect({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }),
    );

    expect(snapshot).toMatchObject({
      app: "myapp",
      service: "web",
      providerId: "test",
      status: "running",
    });
  });

  test("fails with a tagged ContractFailure for malformed providers", async () => {
    const malformedProvider = {
      ...TestRuntimeProvider,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        serviceExec: undefined,
      },
    } as typeof TestRuntimeProvider;

    const result = await Effect.runPromiseExit(runProviderContract(malformedProvider));

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.cause._tag).toBe("Fail");
      if (result.cause._tag === "Fail") {
        expect(result.cause.error).toBeInstanceOf(ContractFailure);
        expect(result.cause.error._tag).toBe("ContractFailure");
      }
    }
  });

  test("matches the RuntimeProvider service shape", () => {
    const provider: typeof RuntimeProvider.Service = TestRuntimeProvider;

    expect(provider.id).toBe("test");
  });
});
