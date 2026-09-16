import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { ProviderError } from "@lando/sdk/services";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import {
  MINIMUM_PODMAN_VERSION,
  type PodmanCommandRunner,
  type SetupOptions,
  setupProviderLando,
} from "../src/setup.ts";

const podmanCommand = (output: string): PodmanCommandRunner => ({
  version: Effect.succeed(output),
});

const podmanApi = (version: string): PodmanApiClient => ({
  info: Effect.succeed({ version: { Version: version } }),
  ping: Effect.succeed(undefined),
});

const runSetup = (options: SetupOptions) => Effect.runPromiseExit(setupProviderLando(options));

const expectVersionRejection = (
  exit: Exit.Exit<unknown, ProviderError>,
  expected: { readonly version: string; readonly source: string },
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
  expect(error.providerId).toBe("lando");
  expect(error.operation).toBe("setup");
  expect(error.details).toEqual({
    observedVersion: expected.version,
    source: expected.source,
    minimumVersion: MINIMUM_PODMAN_VERSION,
  });
  expect(error.remediation).toContain(`Podman >= ${MINIMUM_PODMAN_VERSION}`);
};

describe("provider-lando setup version gate (CLI source)", () => {
  test("rejects podman --version output below the floor", async () => {
    const exit = await runSetup({
      platform: "linux",
      podmanCommand: podmanCommand("podman version 5.2.0"),
      skipSocketProbe: true,
    });

    expectVersionRejection(exit, { version: "5.2.0", source: "cli" });
  });

  test("accepts podman --version output at the floor", async () => {
    const exit = await runSetup({
      platform: "linux",
      podmanCommand: podmanCommand("podman version 6.0.0"),
      skipSocketProbe: true,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.podmanVersion).toBe("6.0.0");
    }
  });

  test("accepts a pre-release above the floor as its numeric version", async () => {
    const exit = await runSetup({
      platform: "linux",
      podmanCommand: podmanCommand("podman version 6.1.0-rc1"),
      skipSocketProbe: true,
    });

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("provider-lando setup version gate (API info source)", () => {
  test("rejects an API info server version below the floor", async () => {
    const exit = await runSetup({
      platform: "linux",
      podmanCommand: podmanCommand("podman version 6.0.2"),
      podmanApi: podmanApi("5.2.0"),
      socketPath: "/tmp/lando-test-podman.sock",
    });

    expectVersionRejection(exit, { version: "5.2.0", source: "api-info" });
  });

  test("accepts an API info server version at or above the floor", async () => {
    const exit = await runSetup({
      platform: "linux",
      podmanCommand: podmanCommand("podman version 6.0.2"),
      podmanApi: podmanApi("6.1.0-rc1"),
      socketPath: "/tmp/lando-test-podman.sock",
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.podmanVersion).toBe("6.1.0-rc1");
    }
  });
});
