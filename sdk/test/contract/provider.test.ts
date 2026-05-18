import { describe, expect, test } from "bun:test";

import { Effect, Stream } from "effect";

import { AppId, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProvider } from "@lando/sdk/services";
import { ContractFailure, TestRuntimeProvider, runProviderContract } from "@lando/sdk/test";

const TEST_APP_ID = AppId.make("myapp");
const TEST_SERVICE_NAME = ServiceName.make("web");

const expectContractFailure = async (
  provider: typeof TestRuntimeProvider,
  assertion: string,
): Promise<void> => {
  const result = await Effect.runPromiseExit(runProviderContract(provider));

  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.cause._tag).toBe("Fail");
  if (result.cause._tag !== "Fail") return;
  expect(result.cause.error).toBeInstanceOf(ContractFailure);
  expect(result.cause.error._tag).toBe("ContractFailure");
  expect(result.cause.error.assertion).toBe(assertion);
};

describe("RuntimeProvider contract", () => {
  test("exports a runnable Effect contract helper", async () => {
    const contract = runProviderContract(TestRuntimeProvider);

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

    await expectContractFailure(malformedProvider, "capability matrix decodes");
  });

  test("fails with ContractFailure when a ProviderCapabilities field is missing", async () => {
    const { copyMounts: _omitted, ...partialCapabilities } = TestRuntimeProvider.capabilities;
    const incompleteProvider = {
      ...TestRuntimeProvider,
      capabilities: partialCapabilities,
    } as typeof TestRuntimeProvider;

    await expectContractFailure(incompleteProvider, "capability matrix decodes");
  });

  test("fails with ContractFailure when getStatus omits the running boolean", async () => {
    const provider = {
      ...TestRuntimeProvider,
      getStatus: Effect.succeed({ message: "missing-running" } as unknown as {
        readonly running: boolean;
      }),
    } as typeof TestRuntimeProvider;

    await expectContractFailure(provider, "getStatus returns a running boolean");
  });

  test("fails with ContractFailure when getVersions returns an empty provider string", async () => {
    const provider = {
      ...TestRuntimeProvider,
      getVersions: Effect.succeed({ provider: "", runtime: "0.0.0-test" }),
    } as typeof TestRuntimeProvider;

    await expectContractFailure(provider, "getVersions returns a non-empty provider version");
  });

  test("fails with ContractFailure when apply does not return ApplyResult.changed", async () => {
    const provider = {
      ...TestRuntimeProvider,
      apply: () => Effect.succeed({} as unknown as { changed: boolean }),
    } as typeof TestRuntimeProvider;

    await expectContractFailure(provider, "apply returns ApplyResult with a boolean changed field");
  });

  test("fails with ContractFailure when list does not return an array", async () => {
    const provider = {
      ...TestRuntimeProvider,
      list: () => Effect.succeed("not-an-array"),
    } as unknown as typeof TestRuntimeProvider;

    await expectContractFailure(provider, "list returns an array of service runtime snapshots");
  });

  test("fails with ContractFailure when provider identity is empty", async () => {
    const provider = { ...TestRuntimeProvider, displayName: "" } as typeof TestRuntimeProvider;

    await expectContractFailure(provider, "provider exposes a non-empty displayName");
  });

  test("matches the RuntimeProvider service shape", () => {
    const provider: typeof RuntimeProvider.Service = TestRuntimeProvider;

    expect(provider.id).toBe("test");
  });
});
