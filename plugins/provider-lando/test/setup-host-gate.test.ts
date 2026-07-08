import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import { isIntelMacHost } from "../src/host-support.ts";
import {
  IntelMacUnsupportedError,
  type PodmanMachineRunner,
  type PodmanMachineStatus,
  type SetupOptions,
  setupProviderLando,
} from "../src/setup.ts";

const podmanCommand = (version: string) => ({ version: Effect.succeed(version) });

const machineRunner = (status: PodmanMachineStatus, calls: string[]): PodmanMachineRunner => ({
  inspect: Effect.sync(() => {
    calls.push("inspect");
    return status;
  }),
  create: Effect.sync(() => calls.push("create")).pipe(Effect.asVoid),
  start: Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
  stop: Effect.sync(() => calls.push("stop")).pipe(Effect.asVoid),
  upgrade: Effect.sync(() => calls.push("upgrade")).pipe(Effect.asVoid),
  teardown: Effect.sync(() => calls.push("teardown")).pipe(Effect.asVoid),
});

const runSetup = (options: SetupOptions) => Effect.runPromiseExit(setupProviderLando(options));

describe("isIntelMacHost", () => {
  test("is true only for macOS on x86_64", () => {
    expect(isIntelMacHost("darwin", "x64")).toBe(true);
    expect(isIntelMacHost("darwin", "x86_64")).toBe(true);
    expect(isIntelMacHost("darwin", "arm64")).toBe(false);
    expect(isIntelMacHost("linux", "x64")).toBe(false);
    expect(isIntelMacHost("win32", "x64")).toBe(false);
    expect(isIntelMacHost("darwin", undefined)).toBe(false);
    expect(isIntelMacHost(undefined, "x64")).toBe(false);
  });
});

describe("provider-lando setup Intel Mac host gate", () => {
  test("rejects Intel (x86_64) macOS before any setup step runs", async () => {
    const calls: string[] = [];
    const exit = await runSetup({
      platform: "darwin",
      arch: "x64",
      podmanCommand: podmanCommand("podman version 6.0.2"),
      podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" } }) },
      podmanMachine: machineRunner("missing", calls),
      skipSocketProbe: true,
    });

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "None") return;
    const error = failure.value;
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toBeInstanceOf(IntelMacUnsupportedError);
    expect(error._tag).toBe("ProviderUnavailableError");
    expect(error.providerId).toBe("lando");
    expect(error.operation).toBe("setup");
    expect(error.details).toEqual({ platform: "darwin", arch: "x64" });
    expect(error.message).toContain("Intel");
    expect(error.message).toContain("Podman 6");
    expect(error.remediation).toContain("Apple Silicon");
    expect(error.remediation).toContain("Linux");
    expect(error.remediation).toContain("Windows 11");
    // The gate fails before any Podman machine step is attempted.
    expect(calls).toEqual([]);
  });

  test("accepts Apple Silicon (arm64) macOS past the host gate", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      setupProviderLando({
        platform: "darwin",
        arch: "arm64",
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" } }) },
        podmanCommand: podmanCommand("podman version 6.0.2"),
        podmanMachine: machineRunner("missing", calls),
      }),
    );

    expect(calls).toEqual(["inspect", "create", "start"]);
    expect(result.podmanVersion).toBe("6.0.2");
  });
});
