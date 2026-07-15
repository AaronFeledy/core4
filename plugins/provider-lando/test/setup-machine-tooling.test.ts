import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import {
  type PodmanCommandRunner,
  type PodmanMachineRunner,
  type PodmanMachineStatus,
  providerStatePath,
  setupProviderLando,
} from "../src/setup.ts";

const podmanCommand = (output: string): PodmanCommandRunner => ({
  version: Effect.succeed(output),
});

const machineRunner = (status: PodmanMachineStatus, calls: string[] = []): PodmanMachineRunner => ({
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

describe("provider-lando bundled machine tooling resolution", () => {
  test("darwin setup fails with tagged remediation when the bundle lacks machine tooling", async () => {
    const runtimeBinDir = await mkdtemp(join(tmpdir(), "lando-bundle-missing-"));
    try {
      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "darwin",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBinDir,
          skipSocketProbe: true,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          const error = failure.value as ProviderUnavailableError;
          expect(error.message).toContain("darwin");
          expect(
            `${error.message} ${error.remediation ?? ""} ${JSON.stringify(error.details ?? {})}`,
          ).toContain(`${runtimeBinDir}/podman`);
        }
      }
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("win32 setup fails with tagged remediation when the bundle lacks machine tooling", async () => {
    const runtimeBinDir = await mkdtemp(join(tmpdir(), "lando-bundle-missing-win-"));
    try {
      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "win32",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBinDir,
          skipSocketProbe: true,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          expect((failure.value as ProviderUnavailableError).message).toContain("win32");
        }
      }
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("win32 setup names a missing win-sshproxy helper before starting the machine", async () => {
    const runtimeBinDir = await mkdtemp(join(tmpdir(), "lando-bundle-missing-win-helper-"));
    let machineRunnerCreated = false;
    try {
      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "win32",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBinDir,
          skipSocketProbe: true,
          _machineToolingExists: (path) => path.endsWith("podman.exe") || path.endsWith("gvproxy.exe"),
          _machineRunnerFactory: () => {
            machineRunnerCreated = true;
            return machineRunner("missing");
          },
        }),
      );

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
      expect(machineRunnerCreated).toBe(false);
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("darwin setup resolves the machine runner from the bundled Podman path", async () => {
    const runtimeBinDir = await mkdtemp(join(tmpdir(), "lando-bundle-darwin-"));
    const stateDir = await mkdtemp(join(tmpdir(), "lando-bundle-darwin-state-"));
    const commands: string[] = [];
    const calls: string[] = [];
    try {
      await Effect.runPromise(
        setupProviderLando({
          platform: "darwin",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBinDir,
          socketPath: "/tmp/lando-managed.sock",
          skipSocketProbe: true,
          stateDir,
          _machineToolingExists: () => true,
          _machineRunnerFactory: (command) => {
            commands.push(command);
            return machineRunner("missing", calls);
          },
        }),
      );

      expect(commands).toEqual([`${runtimeBinDir}/podman`]);
      expect(calls).toEqual(["inspect", "create", "start"]);

      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state.machine).toEqual({ name: "lando", createdByLando: true });
      expect(state.socketPath).toBe("/tmp/lando-managed.sock");
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("win32 setup resolves the machine runner from the bundled Podman path", async () => {
    const runtimeBinDir = await mkdtemp(join(tmpdir(), "lando-bundle-win-"));
    const commands: string[] = [];
    try {
      await Effect.runPromise(
        setupProviderLando({
          platform: "win32",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          runtimeBinDir,
          skipSocketProbe: true,
          _machineToolingExists: () => true,
          _machineRunnerFactory: (command) => {
            commands.push(command);
            return machineRunner("missing");
          },
        }),
      );

      expect(commands).toEqual([`${runtimeBinDir}/podman.exe`]);
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("win32 setup detects the Podman version from the bundled executable", async () => {
    const runtimeBinDir = await mkdtemp(join(tmpdir(), "lando-bundle-version-win-"));
    try {
      await writeFile(join(runtimeBinDir, "podman.exe"), '#!/bin/sh\necho "podman version 9.9.9-bundled"\n', {
        mode: 0o755,
      });

      const result = await Effect.runPromise(
        setupProviderLando({
          platform: "win32",
          runtimeBinDir,
          skipSocketProbe: true,
          _machineToolingExists: () => true,
          _machineRunnerFactory: () => machineRunner("running"),
        }),
      );

      expect(result.podmanVersion).toBe("9.9.9-bundled");
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("darwin setup detects the Podman version from the bundled binary, not system PATH", async () => {
    const runtimeBinDir = await mkdtemp(join(tmpdir(), "lando-bundle-version-"));
    try {
      await writeFile(join(runtimeBinDir, "podman"), '#!/bin/sh\necho "podman version 9.9.9-bundled"\n', {
        mode: 0o755,
      });

      const result = await Effect.runPromise(
        setupProviderLando({
          platform: "darwin",
          runtimeBinDir,
          skipSocketProbe: true,
          _machineToolingExists: () => true,
          _machineRunnerFactory: () => machineRunner("running"),
        }),
      );

      expect(result.podmanVersion).toBe("9.9.9-bundled");
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("linux setup detects the Podman version from the bundled binary, not system PATH", async () => {
    const runtimeBinDir = await mkdtemp(join(tmpdir(), "lando-bundle-version-linux-"));
    try {
      await writeFile(join(runtimeBinDir, "podman"), '#!/bin/sh\necho "podman version 9.9.9-bundled"\n', {
        mode: 0o755,
      });

      const result = await Effect.runPromise(
        setupProviderLando({
          platform: "linux",
          runtimeBinDir,
          skipSocketProbe: true,
        }),
      );

      expect(result.podmanVersion).toBe("9.9.9-bundled");
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("darwin Detect Podman step fails with bundle remediation, not PATH wording, when the bundled binary is absent", async () => {
    const runtimeBinDir = await mkdtemp(join(tmpdir(), "lando-bundle-detect-missing-"));
    try {
      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "darwin",
          runtimeBinDir,
          skipSocketProbe: true,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          const error = failure.value as ProviderUnavailableError;
          expect(error.constructor.name).not.toBe("PodmanNotInstalledError");
          expect(error.message).toContain("darwin");
          expect(
            `${error.message} ${error.remediation ?? ""} ${JSON.stringify(error.details ?? {})}`,
          ).toContain(`${runtimeBinDir}/podman`);
        }
      }
    } finally {
      await rm(runtimeBinDir, { recursive: true, force: true });
    }
  });

  test("an explicitly injected machine runner bypasses bundle resolution", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      setupProviderLando({
        platform: "darwin",
        podmanCommand: podmanCommand("podman version 6.0.2"),
        podmanMachine: machineRunner("missing", calls),
        skipSocketProbe: true,
        // No runtimeBinDir: the injected runner must be used without a bundle probe.
      }),
    );

    expect(calls).toEqual(["inspect", "create", "start"]);
    expect(result.podmanVersion).toBe("6.0.2");
  });
});
