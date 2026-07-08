import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import type { HostPlatform } from "@lando/sdk/schema";

import { type MachineSpawn, makeSystemPodmanMachineRunner } from "../src/setup.ts";

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

const runnerFor = (platform: HostPlatform, spawn: MachineSpawn) =>
  makeSystemPodmanMachineRunner("podman", "lando", platform, spawn);

describe("provider-lando system machine runner argv", () => {
  for (const platform of ["darwin", "win32"] as const) {
    test(`${platform} start preserves the default connection`, async () => {
      const { spawn, calls } = capturingSpawn();
      await Effect.runPromise(runnerFor(platform, spawn).start);
      expect(calls).toEqual([["podman", "machine", "start", "--update-connection=false", "lando"]]);
    });

    test(`${platform} create argv is unchanged`, async () => {
      const { spawn, calls } = capturingSpawn();
      await Effect.runPromise(runnerFor(platform, spawn).create);
      expect(calls).toEqual([["podman", "machine", "init", "lando"]]);
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
});
