import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import type { PodmanApiClient } from "../src/capabilities.ts";
import {
  MINIMUM_PODMAN_VERSION,
  type PodmanCommandRunner,
  type SetupOptions,
  setupProviderLando,
} from "../src/setup.ts";
import { parsePodmanVersionNumbers, podmanVersionMeetsFloor } from "../src/version-floor.ts";

const podmanCommand = (output: string): PodmanCommandRunner => ({
  version: Effect.succeed(output),
});

const podmanApi = (version: string): PodmanApiClient => ({
  info: Effect.succeed({ version: { Version: version } }),
});

const runSetup = (options: SetupOptions) => Effect.runPromiseExit(setupProviderLando(options));

const expectVersionRejection = (
  exit: Exit.Exit<unknown, ProviderUnavailableError>,
  expected: { readonly version: string; readonly source: string },
) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") return;
  const error = failure.value;
  expect(error).toBeInstanceOf(ProviderUnavailableError);
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

describe("podman version floor parser", () => {
  test("minimum podman version is the Podman 6 floor", () => {
    expect(MINIMUM_PODMAN_VERSION).toBe("6.0.0");
  });

  test("parses numeric major.minor.patch and ignores pre-release/build suffixes", () => {
    expect(parsePodmanVersionNumbers("6.1.0-rc1")).toEqual({ major: 6, minor: 1, patch: 0 });
    expect(parsePodmanVersionNumbers("6.0.2+build.5")).toEqual({ major: 6, minor: 0, patch: 2 });
    expect(parsePodmanVersionNumbers("podman version 5.2.0")).toEqual({ major: 5, minor: 2, patch: 0 });
    expect(parsePodmanVersionNumbers("not a version")).toBeUndefined();
  });

  test("compares numerically over major.minor.patch", () => {
    expect(podmanVersionMeetsFloor("5.2.0", "6.0.0")).toBe(false);
    expect(podmanVersionMeetsFloor("6.0.0", "6.0.0")).toBe(true);
    expect(podmanVersionMeetsFloor("6.1.0-rc1", "6.0.0")).toBe(true);
    expect(podmanVersionMeetsFloor("10.0.0", "6.0.0")).toBe(true);
    expect(podmanVersionMeetsFloor("6.0.0", "6.0.1")).toBe(false);
    expect(podmanVersionMeetsFloor("not a version", "6.0.0")).toBe(false);
  });
});

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
