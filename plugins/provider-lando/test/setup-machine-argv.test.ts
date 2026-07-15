import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import type { HostPlatform } from "@lando/sdk/schema";

import { classifyWindowsManagedSetupResult } from "../../../scripts/windows-managed-setup-acceptance.ts";
import {
  type MachineSpawn,
  WindowsMachinePrerequisiteError,
  makeSystemPodmanMachineRunner,
} from "../src/setup.ts";

interface CapturingSpawn {
  readonly spawn: MachineSpawn;
  readonly calls: string[][];
}

const capturingSpawn = (): CapturingSpawn => {
  const calls: string[][] = [];
  const spawn: MachineSpawn = (argv) => {
    calls.push([...argv]);
    return { stdout: null, stderr: null, exited: Promise.resolve(0) };
  };
  return { spawn, calls };
};

const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const runnerFor = (platform: HostPlatform, spawn: MachineSpawn) =>
  makeSystemPodmanMachineRunner("podman", "lando", platform, spawn);

describe("provider-lando system machine runner argv", () => {
  for (const platform of ["darwin", "win32"] as const) {
    test(`${platform} start preserves the default connection`, async () => {
      const { spawn, calls } = capturingSpawn();
      await Effect.runPromise(runnerFor(platform, spawn).start);
      expect(calls).toEqual([["podman", "machine", "start", "--update-connection=false", "lando"]]);
    });

    test(`${platform} create imports the host native CA trust for the Lando-owned machine`, async () => {
      const { spawn, calls } = capturingSpawn();
      await Effect.runPromise(runnerFor(platform, spawn).create);
      expect(calls).toEqual([["podman", "machine", "init", "--import-native-ca", "lando"]]);
    });

    test(`${platform} syncTrust imports native CA trust for an existing Lando-owned machine`, async () => {
      const { spawn, calls } = capturingSpawn();
      const runner = runnerFor(platform, spawn);
      expect(runner.syncTrust).toBeDefined();
      await Effect.runPromise(runner.syncTrust ?? Effect.void);
      expect(calls).toEqual([["podman", "machine", "set", "--import-native-ca", "lando"]]);
    });

    test(`${platform} stop argv is unchanged`, async () => {
      const { spawn, calls } = capturingSpawn();
      await Effect.runPromise(runnerFor(platform, spawn).stop);
      expect(calls).toEqual([["podman", "machine", "stop", "lando"]]);
    });

    test(`${platform} teardown argv is unchanged`, async () => {
      const { spawn, calls } = capturingSpawn();
      await Effect.runPromise(runnerFor(platform, spawn).teardown);
      expect(calls).toEqual([["podman", "machine", "rm", "--force", "lando"]]);
    });
  }

  test("darwin upgrade targets the documented `machine os upgrade` command", async () => {
    const { spawn, calls } = capturingSpawn();
    await Effect.runPromise(runnerFor("darwin", spawn).upgrade);
    expect(calls).toEqual([["podman", "machine", "os", "upgrade", "lando"]]);
  });

  test("win32 upgrade skips the unsupported OS path and fails with WSL remediation", async () => {
    const { spawn, calls } = capturingSpawn();
    const exit = await Effect.runPromiseExit(runnerFor("win32", spawn).upgrade);

    expect(calls).toEqual([]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        const error = failure.value as ProviderUnavailableError;
        expect(`${error.message} ${error.remediation ?? ""}`.toLowerCase()).toContain("wsl");
      }
    }
  });

  test("win32 create with missing Hyper-V prerequisites recommends manual prep and never runs it", async () => {
    const calls: string[][] = [];
    const failingSpawn: MachineSpawn = (argv) => {
      calls.push([...argv]);
      return {
        stdout: streamOf(""),
        stderr: streamOf("Error: hyper-v is not enabled; virtual machine platform is required"),
        exited: Promise.resolve(1),
      };
    };

    const exit = await Effect.runPromiseExit(runnerFor("win32", failingSpawn).create);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        const error = failure.value as ProviderUnavailableError;
        const remediation = error.remediation ?? "";
        expect(remediation).toContain("podman system hyperv-prep");
        expect(/admin/i.test(remediation)).toBe(true);
        expect(/never|does not|will not|won't/i.test(remediation)).toBe(true);
      }
    }

    expect(calls).toEqual([["podman", "machine", "init", "--import-native-ca", "lando"]]);
    expect(calls.some((argv) => argv.includes("hyperv-prep"))).toBe(false);
  });

  test("win32 start reports a missing API forwarding helper by filename", async () => {
    const failingSpawn: MachineSpawn = () => ({
      stdout: streamOf(""),
      stderr: streamOf(
        'Error: could not find "win-sshproxy.exe" in one of [helper_binaries_dir] directories',
      ),
      exited: Promise.resolve(1),
    });

    const exit = await Effect.runPromiseExit(runnerFor("win32", failingSpawn).start);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        const error = failure.value as ProviderUnavailableError;
        expect(error.message).toContain("win-sshproxy.exe");
        expect(error.remediation).toContain("lando setup");
      }
    }
  });

  test("win32 helper failures mentioning WSL cannot become prerequisite skips", async () => {
    const failingSpawn: MachineSpawn = () => ({
      stdout: streamOf(""),
      stderr: streamOf("win-sshproxy WSL connection failed"),
      exited: Promise.resolve(1),
    });

    const exit = await Effect.runPromiseExit(runnerFor("win32", failingSpawn).start);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        expect(failure.value).not.toBeInstanceOf(WindowsMachinePrerequisiteError);
        expect(failure.value.message).toBe("Podman machine start failed.");
        expect(
          classifyWindowsManagedSetupResult({
            exitCode: 2,
            stdout: "",
            stderr: JSON.stringify({
              apiVersion: "v4",
              command: "meta:setup",
              ok: false,
              error: { _tag: failure.value._tag, message: failure.value.message },
            }),
          }),
        ).toMatchObject({ outcome: "failed", exitCode: 1 });
      }
    }
  });
});
