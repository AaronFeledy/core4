import { describe, expect, test } from "bun:test";

import {
  type MachineSpawnResult,
  classifyManagedProviderMachine,
  teardownManagedProviderMachine,
} from "../../src/runtime/managed-provider-machine.ts";

const enoent = (): never => {
  throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
};

const readerReturning = (contents: string) => (): string => contents;

const stateWith = (machine: unknown): string => JSON.stringify({ podmanVersion: "5.2.0", machine });

describe("classifyManagedProviderMachine", () => {
  test("owned when the recorded machine was created by Lando", () => {
    const result = classifyManagedProviderMachine(
      "/data",
      readerReturning(stateWith({ name: "lando", createdByLando: true })),
    );
    expect(result).toEqual({ ownership: "owned", name: "lando" });
  });

  test("not-owned when Lando adopted a pre-existing machine", () => {
    const result = classifyManagedProviderMachine(
      "/data",
      readerReturning(stateWith({ name: "lando", createdByLando: false })),
    );
    expect(result).toEqual({ ownership: "not-owned", name: "lando" });
  });

  test("ambiguous when the setup-state file is corrupt", () => {
    const result = classifyManagedProviderMachine("/data", readerReturning("{ not valid json"));
    expect(result).toEqual({ ownership: "ambiguous" });
  });

  test("ambiguous when the recorded machine name is not the managed name", () => {
    const result = classifyManagedProviderMachine(
      "/data",
      readerReturning(stateWith({ name: "podman-machine-default", createdByLando: true })),
    );
    expect(result).toEqual({ ownership: "ambiguous" });
  });

  test("ambiguous when createdByLando is not a boolean", () => {
    const result = classifyManagedProviderMachine(
      "/data",
      readerReturning(stateWith({ name: "lando", createdByLando: "yes" })),
    );
    expect(result).toEqual({ ownership: "ambiguous" });
  });

  test("absent when setup-state has no machine field", () => {
    const result = classifyManagedProviderMachine(
      "/data",
      readerReturning(JSON.stringify({ podmanVersion: "5" })),
    );
    expect(result).toEqual({ ownership: "absent" });
  });

  test("absent when there is no setup-state file", () => {
    const result = classifyManagedProviderMachine("/data", enoent);
    expect(result).toEqual({ ownership: "absent" });
  });
});

describe("teardownManagedProviderMachine", () => {
  test("removes an owned machine and returns removed", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const spawn = async (args: ReadonlyArray<string>): Promise<MachineSpawnResult> => {
      calls.push(args);
      return { exitCode: 0, stderr: "" };
    };

    const result = await teardownManagedProviderMachine("/data", {
      classify: () => ({ ownership: "owned", name: "lando" }),
      spawn,
    });

    expect(result).toEqual({ removed: true, name: "lando" });
    expect(calls).toEqual([["machine", "rm", "--force", "lando"]]);
  });

  test("treats an already-absent machine (exit 125) as an idempotent no-op", async () => {
    const result = await teardownManagedProviderMachine("/data", {
      classify: () => ({ ownership: "owned", name: "lando" }),
      spawn: async () => ({ exitCode: 125, stderr: "Error: no such machine lando" }),
    });

    expect(result).toEqual({ removed: false, name: "lando" });
  });

  test("rejects with remediation when podman fails for another reason", async () => {
    const teardown = teardownManagedProviderMachine("/data", {
      classify: () => ({ ownership: "owned", name: "lando" }),
      spawn: async () => ({ exitCode: 1, stderr: "boom" }),
    });

    await expect(teardown).rejects.toThrow(/podman machine rm/);
  });

  test("does not touch a not-owned machine", async () => {
    let spawned = false;
    const result = await teardownManagedProviderMachine("/data", {
      classify: () => ({ ownership: "not-owned", name: "lando" }),
      spawn: async () => {
        spawned = true;
        return { exitCode: 0, stderr: "" };
      },
    });

    expect(result).toEqual({ removed: false });
    expect(spawned).toBe(false);
  });

  test("does not spawn when no machine is recorded", async () => {
    let spawned = false;
    const result = await teardownManagedProviderMachine("/data", {
      classify: () => ({ ownership: "absent" }),
      spawn: async () => {
        spawned = true;
        return { exitCode: 0, stderr: "" };
      },
    });

    expect(result).toEqual({ removed: false });
    expect(spawned).toBe(false);
  });
});
