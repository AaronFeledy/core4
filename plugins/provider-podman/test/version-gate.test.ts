import { describe, expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { MINIMUM_PODMAN_VERSION, type PodmanApiClient } from "@lando/provider-lando";
import { makeProviderLayer } from "@lando/provider-podman";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { RuntimeProvider, type RuntimeProviderShape } from "@lando/sdk/services";

const recordingApi = (info: unknown): { readonly api: PodmanApiClient; readonly calls: string[] } => {
  const calls: string[] = [];
  return {
    api: {
      info: Effect.sync(() => {
        calls.push("info");
        return info;
      }),
    },
    calls,
  };
};

const resolveProvider = (api: PodmanApiClient) =>
  Effect.runPromiseExit(
    RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", podmanApi: api }))),
  );

const expectServerVersionRejection = (
  exit: Exit.Exit<RuntimeProviderShape, unknown>,
  observedVersion: string,
) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return;
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag === "None") return;
  const error = failure.value;
  expect(error).toBeInstanceOf(ProviderUnavailableError);
  if (!(error instanceof ProviderUnavailableError)) return;
  expect(error._tag).toBe("ProviderUnavailableError");
  expect(error.providerId).toBe("podman");
  expect(error.operation).toBe("select");
  expect(error.details).toEqual({
    observedVersion,
    source: "libpod-info",
    minimumVersion: MINIMUM_PODMAN_VERSION,
  });
  expect(error.remediation).toContain(`>= ${MINIMUM_PODMAN_VERSION}`);
};

describe("provider-podman server version gate", () => {
  test("rejects a /libpod/info server version below the floor without shelling out", async () => {
    const spawnSpy = spyOn(Bun, "spawn");
    try {
      const { api, calls } = recordingApi({ version: { Version: "5.2.0" } });
      const exit = await resolveProvider(api);

      expectServerVersionRejection(exit, "5.2.0");
      expect(calls).toContain("info");
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("accepts a server version at the floor and reports it through getVersions.runtime", async () => {
    const spawnSpy = spyOn(Bun, "spawn");
    try {
      const { api, calls } = recordingApi({ version: { Version: "6.0.0" } });
      const exit = await resolveProvider(api);

      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      const versions = await Effect.runPromise(exit.value.getVersions);
      expect(versions).toEqual({ provider: "0.0.0", runtime: "6.0.0" });
      expect(calls).toContain("info");
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("accepts a pre-release above the floor and preserves the reported server version", async () => {
    const { api } = recordingApi({ version: { Version: "6.1.0-rc1" } });
    const exit = await resolveProvider(api);

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const versions = await Effect.runPromise(exit.value.getVersions);
    expect(versions).toEqual({ provider: "0.0.0", runtime: "6.1.0-rc1" });
  });

  test("fails closed when /libpod/info reports no server version", async () => {
    const { api } = recordingApi({});
    const exit = await resolveProvider(api);

    expectServerVersionRejection(exit, "unknown");
  });

  test("fails closed when the reported server version is unparseable", async () => {
    const { api } = recordingApi({ version: { Version: "not a version" } });
    const exit = await resolveProvider(api);

    expectServerVersionRejection(exit, "not a version");
  });
});
