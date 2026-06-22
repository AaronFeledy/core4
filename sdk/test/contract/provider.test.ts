import { describe, expect, test } from "bun:test";

import { Effect, Either, Schema, Stream } from "effect";

import {
  NoProviderInstalledError,
  ProviderCapabilityError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import { AbsolutePath, AppId, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProvider } from "@lando/sdk/services";
import {
  ContractFailure,
  type ContractMatrixCell,
  TestRuntimeProvider,
  runProviderContract,
  runProviderContractMatrix,
  runProviderDataPlaneContract,
} from "@lando/sdk/test";

const TEST_APP_ID = AppId.make("myapp");
const TEST_SERVICE_NAME = ServiceName.make("web");
const TEST_COPY_SOURCE = Schema.decodeUnknownSync(AbsolutePath)("/tmp/in.tar");
const TEST_SERVICE_PATH = Schema.decodeUnknownSync(PortablePath)("/app");
const TEST_PROVIDER_ID = Schema.decodeUnknownSync(ProviderId)("test");

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
      Stream.StreamTypeId in
        Object(TestRuntimeProvider.runStream({ image: "alpine", command: ["tar", "c"] })),
    ).toBe(true);
    expect(
      Effect.isEffect(TestRuntimeProvider.inspect({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
    ).toBe(true);
    expect(
      Effect.isEffect(TestRuntimeProvider.snapshotVolume({ volume: { app: TEST_APP_ID, store: "data" } })),
    ).toBe(true);
    expect(
      Effect.isEffect(
        TestRuntimeProvider.restoreVolume({
          snapshot: { provider: "test", id: "snap-1" },
          target: { app: TEST_APP_ID, store: "data" },
        }),
      ),
    ).toBe(true);
    expect(Effect.isEffect(TestRuntimeProvider.listVolumes({ app: TEST_APP_ID }))).toBe(true);
    expect(Effect.isEffect(TestRuntimeProvider.removeVolume({ app: TEST_APP_ID, store: "data" }))).toBe(true);
    expect(
      Effect.isEffect(
        TestRuntimeProvider.copyToService(
          { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
          { sourcePath: TEST_COPY_SOURCE, targetPath: TEST_SERVICE_PATH },
        ),
      ),
    ).toBe(true);
    expect(
      Stream.StreamTypeId in
        Object(
          TestRuntimeProvider.copyFromService(
            { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
            { sourcePath: TEST_SERVICE_PATH },
          ),
        ),
    ).toBe(true);
    expect(
      Stream.StreamTypeId in
        Object(TestRuntimeProvider.exportArtifact({ providerId: TEST_PROVIDER_ID, ref: "web:test" })),
    ).toBe(true);
    expect(Effect.isEffect(TestRuntimeProvider.importArtifact(Stream.make(new Uint8Array([1, 2, 3]))))).toBe(
      true,
    );

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
    } as unknown as typeof TestRuntimeProvider;

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

  test("fails with ContractFailure when runStream is missing", async () => {
    const { runStream: _omitted, ...provider } = TestRuntimeProvider;

    await expectContractFailure(provider as unknown as typeof TestRuntimeProvider, "runStream is callable");
  });

  test("fails with ContractFailure when a data-plane method is missing", async () => {
    const { snapshotVolume: _omitted, ...provider } = TestRuntimeProvider;

    await expectContractFailure(
      provider as unknown as typeof TestRuntimeProvider,
      "snapshotVolume is callable",
    );
  });

  test("fails with ContractFailure when provider identity is empty", async () => {
    const provider = { ...TestRuntimeProvider, displayName: "" } as typeof TestRuntimeProvider;

    await expectContractFailure(provider, "provider exposes a non-empty displayName");
  });

  test("fails with ContractFailure when start does not return an Effect", async () => {
    const provider = {
      ...TestRuntimeProvider,
      start: () => "not-an-effect",
    } as unknown as typeof TestRuntimeProvider;

    await expectContractFailure(provider, "start is Effect-typed");
  });

  test("matches the RuntimeProvider service shape", () => {
    const provider: typeof RuntimeProvider.Service = TestRuntimeProvider;

    expect(provider.id).toBe("test");
  });

  test("fails with ContractFailure when setup is not callable", async () => {
    const provider = {
      ...TestRuntimeProvider,
      setup: undefined,
    } as unknown as typeof TestRuntimeProvider;

    await expectContractFailure(provider, "setup is callable");
  });

  test("fails with ContractFailure when setup does not return an Effect", async () => {
    const provider = {
      ...TestRuntimeProvider,
      setup: (_options: { force: boolean }) => "not-an-effect" as unknown as Effect.Effect<void>,
    } as typeof TestRuntimeProvider;

    await expectContractFailure(provider, "setup returns an Effect");
  });

  test("fails with ContractFailure when getVersions.bundle is not a string", async () => {
    const provider = {
      ...TestRuntimeProvider,
      getVersions: Effect.succeed({
        provider: "0.0.0-test",
        runtime: "0.0.0-test",
        bundle: 42 as unknown as string,
      }),
    } as typeof TestRuntimeProvider;

    await expectContractFailure(provider, "getVersions bundle is a string when present");
  });

  test("accepts an absent getVersions.bundle field", async () => {
    const provider = {
      ...TestRuntimeProvider,
      getVersions: Effect.succeed({ provider: "0.0.0-test" }),
    } as typeof TestRuntimeProvider;

    await expect(Effect.runPromise(runProviderContract(provider))).resolves.toBeUndefined();
  });

  test("accepts a defined string getVersions.bundle field", async () => {
    const provider = {
      ...TestRuntimeProvider,
      getVersions: Effect.succeed({
        provider: "0.0.0-test",
        runtime: "0.0.0-test",
        bundle: "0.1.0-test",
      }),
    } as typeof TestRuntimeProvider;

    await expect(Effect.runPromise(runProviderContract(provider))).resolves.toBeUndefined();
  });

  test("data-plane contract round-trips volume, service, and artifact bytes", async () => {
    await expect(
      Effect.runPromise(
        runProviderDataPlaneContract({
          providerName: "test",
          factory: () => Effect.succeed(TestRuntimeProvider),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  test("data-plane contract fails when service copy does not round-trip", async () => {
    const provider = {
      ...TestRuntimeProvider,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        serviceFileCopy: "native" as const,
      },
      copyFromService: () => Stream.make(new TextEncoder().encode("wrong")),
    } as typeof TestRuntimeProvider;

    const exit = await Effect.runPromiseExit(
      runProviderDataPlaneContract({
        providerName: "broken-copy",
        factory: () => Effect.succeed(provider),
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("copyToService/copyFromService round-trips bytes");
  });

  test("data-plane contract fails when native volume snapshots do not restore bytes", async () => {
    const provider = {
      ...TestRuntimeProvider,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        volumeSnapshot: "native" as const,
      },
      restoreVolume: () => Effect.void,
    } as typeof TestRuntimeProvider;

    const exit = await Effect.runPromiseExit(
      runProviderDataPlaneContract({
        providerName: "broken-native-volume",
        factory: () => Effect.succeed(provider),
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("snapshot -> mutate -> restore restores volume bytes");
  });

  test("data-plane contract fails with CapabilityError when ephemeral mounts are missing", async () => {
    const provider = {
      ...TestRuntimeProvider,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        ephemeralMounts: false,
      },
    } as typeof TestRuntimeProvider;

    const exit = await Effect.runPromiseExit(
      runProviderDataPlaneContract({
        providerName: "no-ephemeral-mounts",
        factory: () => Effect.succeed(provider),
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe(
      "data-plane contract without ephemeral mounts fails CapabilityError",
    );
  });

  test("data-plane contract fails when runStream exits non-zero", async () => {
    const provider = {
      ...TestRuntimeProvider,
      runStream: () =>
        Stream.make(
          { kind: "stdout" as const, chunk: new Uint8Array([0, 1, 2, 3, 128, 255]) },
          { exitCode: 1 },
        ),
    } as typeof TestRuntimeProvider;

    const exit = await Effect.runPromiseExit(
      runProviderDataPlaneContract({
        providerName: "non-zero-runstream",
        factory: () => Effect.succeed(provider),
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("volume export via runStream succeeds");
  });
});

describe("SDK provider error contract", () => {
  test("ProviderCapabilityError carries the base fields plus capability/required/actual", () => {
    const error = new ProviderCapabilityError({
      providerId: "lando",
      operation: "isAvailable",
      message: "Missing capability bindMounts",
      details: { secret: "REDACTED" },
      remediation: "Run lando setup.",
      cause: new Error("io"),
      capability: "bindMounts",
      requiredValue: true,
      actualValue: false,
    });

    expect(error._tag).toBe("ProviderCapabilityError");
    expect(error.providerId).toBe("lando");
    expect(error.operation).toBe("isAvailable");
    expect(error.message).toBe("Missing capability bindMounts");
    expect(error.details).toEqual({ secret: "REDACTED" });
    expect(error.remediation).toBe("Run lando setup.");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.capability).toBe("bindMounts");
    expect(error.requiredValue).toBe(true);
    expect(error.actualValue).toBe(false);
  });

  test("ProviderUnavailableError carries the base fields", () => {
    const error = new ProviderUnavailableError({
      providerId: "podman",
      operation: "podman-api",
      message: "API socket unreachable.",
      remediation: "Start Podman Desktop.",
      cause: new Error("ENOENT"),
    });

    expect(error._tag).toBe("ProviderUnavailableError");
    expect(error.providerId).toBe("podman");
    expect(error.operation).toBe("podman-api");
    expect(error.message).toBe("API socket unreachable.");
    expect(error.remediation).toBe("Start Podman Desktop.");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("NoProviderInstalledError carries message + optional suggestion", () => {
    const error = new NoProviderInstalledError({
      message: "No runtime provider is installed.",
      suggestion: "Run `lando setup`.",
    });

    expect(error._tag).toBe("NoProviderInstalledError");
    expect(error.message).toBe("No runtime provider is installed.");
    expect(error.suggestion).toBe("Run `lando setup`.");
  });

  test("decoding ProviderCapabilityError preserves redacted details", () => {
    const decoded = Schema.decodeUnknownEither(ProviderCapabilityError)({
      _tag: "ProviderCapabilityError",
      providerId: "docker",
      operation: "info",
      message: "info failed",
      details: { auth: "REDACTED" },
      capability: "rootless",
      requiredValue: true,
      actualValue: false,
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.details).toEqual({ auth: "REDACTED" });
    }
  });
});

describe("runProviderContractMatrix", () => {
  test("is exported as an Effect-returning matrix runner", () => {
    expect(typeof runProviderContractMatrix).toBe("function");
  });

  test("runs supported cells and reports skipped cells with reason", async () => {
    const cells: ReadonlyArray<ContractMatrixCell> = [
      {
        platform: "linux" as const,
        supported: true,
        factory: () => Effect.succeed(TestRuntimeProvider),
      },
      {
        platform: "darwin" as const,
        supported: false,
        skipReason: "not yet supported",
      },
      {
        platform: "win32" as const,
        supported: false,
        skipReason: "not yet supported",
      },
      {
        platform: "wsl" as const,
        supported: false,
        skipReason: "not yet supported",
      },
    ];

    const report = await Effect.runPromise(runProviderContractMatrix({ providerName: "test", cells }));

    expect(report.providerName).toBe("test");
    expect(report.results).toHaveLength(4);
    expect(report.results[0]).toMatchObject({ platform: "linux", outcome: "passed" });
    expect(report.results[1]).toMatchObject({
      platform: "darwin",
      outcome: "skipped",
      reason: "not yet supported",
    });
  });

  test("fails with ContractFailure when a supported cell's contract fails", async () => {
    const broken = {
      ...TestRuntimeProvider,
      displayName: "",
    } as typeof TestRuntimeProvider;

    const exit = await Effect.runPromiseExit(
      runProviderContractMatrix({
        providerName: "broken",
        cells: [
          {
            platform: "linux" as const,
            supported: true,
            factory: () => Effect.succeed(broken),
          },
          { platform: "darwin" as const, supported: false, skipReason: "not supported" },
          { platform: "win32" as const, supported: false, skipReason: "not supported" },
          { platform: "wsl" as const, supported: false, skipReason: "not supported" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("provider exposes a non-empty displayName");
  });

  test("fails with ContractFailure when a supported cell returns the wrong provider platform", async () => {
    const exit = await Effect.runPromiseExit(
      runProviderContractMatrix({
        providerName: "wrong-platform",
        cells: [
          {
            platform: "linux" as const,
            supported: true,
            factory: () => Effect.succeed({ ...TestRuntimeProvider, platform: "darwin" }),
          },
          { platform: "darwin" as const, supported: false, skipReason: "not supported" },
          { platform: "win32" as const, supported: false, skipReason: "not supported" },
          { platform: "wsl" as const, supported: false, skipReason: "not supported" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("matrix cell provider platform matches cell platform");
  });

  test("requires every canonical host platform to be declared", async () => {
    const exit = await Effect.runPromiseExit(
      runProviderContractMatrix({
        providerName: "missing-platform",
        cells: [
          { platform: "linux" as const, supported: true, factory: () => Effect.succeed(TestRuntimeProvider) },
          { platform: "darwin" as const, supported: false, skipReason: "not supported" },
          { platform: "win32" as const, supported: false, skipReason: "not supported" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("matrix declares every canonical host platform");
  });

  test("requires a skipReason for unsupported cells", async () => {
    const exit = await Effect.runPromiseExit(
      runProviderContractMatrix({
        providerName: "missing-skip-reason",
        cells: [
          {
            platform: "linux" as const,
            supported: true,
            factory: () => Effect.succeed(TestRuntimeProvider),
          },
          {
            platform: "darwin" as const,
            supported: false,
          } as unknown as {
            platform: "darwin";
            supported: false;
            skipReason: string;
          },
          { platform: "win32" as const, supported: false, skipReason: "not supported" },
          { platform: "wsl" as const, supported: false, skipReason: "not supported" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("unsupported matrix cell declares a skip reason");
  });

  test("requires every cell with supported=true to provide a factory", async () => {
    const exit = await Effect.runPromiseExit(
      runProviderContractMatrix({
        providerName: "missing-factory",
        cells: [
          {
            platform: "linux" as const,
            supported: true,
          } as unknown as {
            platform: "linux";
            supported: true;
            factory: () => Effect.Effect<typeof TestRuntimeProvider>;
          },
          { platform: "darwin" as const, supported: false, skipReason: "not supported" },
          { platform: "win32" as const, supported: false, skipReason: "not supported" },
          { platform: "wsl" as const, supported: false, skipReason: "not supported" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("supported matrix cell declares a factory");
  });
});
