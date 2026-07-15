import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import {
  type PodmanCommandRunner,
  type PodmanMachineRunner,
  type PodmanMachineStatus,
  ensureMacOSPodmanMachine,
  ensureWindowsPodmanMachine,
  providerStatePath,
  setupProviderLando,
} from "../src/setup.ts";

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
  syncTrust: Effect.sync(() => calls.push("syncTrust")).pipe(Effect.asVoid),
});

const podmanCommand = (output: string): PodmanCommandRunner => ({
  version: Effect.succeed(output),
});

describe("provider-lando machine ownership recording", () => {
  test("ensureMacOSPodmanMachine reports it created the machine when it was missing", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(ensureMacOSPodmanMachine(machineRunner("missing", calls)));

    expect(result).toEqual({ createdByLando: true });
    expect(calls).toEqual(["inspect", "create", "start"]);
  });

  test("ensureMacOSPodmanMachine reports it adopted a stopped machine", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(ensureMacOSPodmanMachine(machineRunner("stopped", calls)));

    expect(result).toEqual({ createdByLando: false });
    expect(calls).toEqual(["inspect", "start"]);
  });

  test("ensureMacOSPodmanMachine reports it adopted an already-running machine", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(ensureMacOSPodmanMachine(machineRunner("running", calls)));

    expect(result).toEqual({ createdByLando: false });
    expect(calls).toEqual(["inspect"]);
  });

  test("ensureWindowsPodmanMachine reports it created a missing machine", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(ensureWindowsPodmanMachine(machineRunner("missing", calls)));

    expect(result).toEqual({ createdByLando: true });
    expect(calls).toEqual(["inspect", "create", "start"]);
  });

  for (const [platform, ensureMachine] of [
    ["macOS", ensureMacOSPodmanMachine],
    ["Windows", ensureWindowsPodmanMachine],
  ] as const) {
    test(`${platform} restarts a running Lando-owned machine after enabling native CA import`, async () => {
      const calls: string[] = [];

      const result = await Effect.runPromise(
        ensureMachine(machineRunner("running", calls), { name: "lando", createdByLando: true }),
      );

      expect(result).toEqual({ createdByLando: false });
      expect(calls).toEqual(["inspect", "syncTrust", "stop", "start"]);
    });
  }

  test("setup persists machine ownership on macOS when it created the machine", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-machine-owned-"));
    try {
      await Effect.runPromise(
        setupProviderLando({
          platform: "darwin",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          podmanMachine: machineRunner("missing", []),
          skipSocketProbe: true,
          stateDir,
        }),
      );

      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state.machine).toEqual({ name: "lando", createdByLando: true });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("setup persists not-owned machine ownership on macOS when it adopted a machine", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-machine-adopted-"));
    try {
      await Effect.runPromise(
        setupProviderLando({
          platform: "darwin",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          podmanMachine: machineRunner("running", []),
          skipSocketProbe: true,
          stateDir,
        }),
      );

      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state.machine).toEqual({ name: "lando", createdByLando: false });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("setup preserves recorded Lando-created ownership across reruns", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-machine-rerun-owned-"));
    try {
      await Effect.runPromise(
        setupProviderLando({
          platform: "darwin",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          podmanMachine: machineRunner("missing", []),
          skipSocketProbe: true,
          stateDir,
        }),
      );

      await Effect.runPromise(
        setupProviderLando({
          platform: "darwin",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          podmanMachine: machineRunner("running", []),
          skipSocketProbe: true,
          stateDir,
        }),
      );

      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state.machine).toEqual({ name: "lando", createdByLando: true });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("setup syncs trust for an existing running machine previously created by Lando", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-machine-trust-owned-"));
    try {
      await mkdir(join(stateDir, "provider-lando"), { recursive: true });
      await writeFile(
        providerStatePath(stateDir),
        JSON.stringify({ podmanVersion: "6.0.2", machine: { name: "lando", createdByLando: true } }),
      );
      const calls: string[] = [];

      await Effect.runPromise(
        setupProviderLando({
          platform: "darwin",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          podmanMachine: machineRunner("running", calls),
          skipSocketProbe: true,
          stateDir,
        }),
      );

      expect(calls).toEqual(["inspect", "syncTrust", "stop", "start"]);
      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state.machine).toEqual({ name: "lando", createdByLando: true });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("setup does not sync trust for an existing user-owned machine", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-machine-trust-user-"));
    try {
      await mkdir(join(stateDir, "provider-lando"), { recursive: true });
      await writeFile(
        providerStatePath(stateDir),
        JSON.stringify({ podmanVersion: "6.0.2", machine: { name: "lando", createdByLando: false } }),
      );
      const calls: string[] = [];

      await Effect.runPromise(
        setupProviderLando({
          platform: "darwin",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          podmanMachine: machineRunner("running", calls),
          skipSocketProbe: true,
          stateDir,
        }),
      );

      expect(calls).toEqual(["inspect"]);
      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state.machine).toEqual({ name: "lando", createdByLando: false });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("setup fails instead of downgrading ownership when prior state cannot be parsed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-machine-corrupt-"));
    try {
      await Effect.runPromise(
        setupProviderLando({
          platform: "darwin",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          podmanMachine: machineRunner("missing", []),
          skipSocketProbe: true,
          stateDir,
        }),
      );

      const statePath = providerStatePath(stateDir);
      const before = await readFile(statePath, "utf8");
      await writeFile(statePath, "{not valid json");

      const exit = await Effect.runPromiseExit(
        setupProviderLando({
          platform: "darwin",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          podmanMachine: machineRunner("running", []),
          skipSocketProbe: true,
          stateDir,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        }
      }

      expect(before).toContain('"createdByLando": true');
      expect(await readFile(statePath, "utf8")).toBe("{not valid json");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("setup omits the machine field on Linux where no VM is managed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-machine-linux-"));
    try {
      await Effect.runPromise(
        setupProviderLando({
          platform: "linux",
          podmanCommand: podmanCommand("podman version 6.0.2"),
          skipSocketProbe: true,
          stateDir,
        }),
      );

      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state.machine).toBeUndefined();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
