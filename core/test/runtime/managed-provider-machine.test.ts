import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

  test("absent on Linux when setup-state has no machine field", () => {
    const result = classifyManagedProviderMachine(
      "/data",
      readerReturning(JSON.stringify({ podmanVersion: "5" })),
      "linux",
    );
    expect(result).toEqual({ ownership: "absent" });
  });

  test("ambiguous on macOS when setup-state has no machine field", () => {
    const result = classifyManagedProviderMachine(
      "/data",
      readerReturning(JSON.stringify({ podmanVersion: "5" })),
      "darwin",
    );
    expect(result).toEqual({ ownership: "ambiguous" });
  });

  test("ambiguous on Windows when setup-state has no machine field", () => {
    const result = classifyManagedProviderMachine(
      "/data",
      readerReturning(JSON.stringify({ podmanVersion: "5" })),
      "win32",
    );
    expect(result).toEqual({ ownership: "ambiguous" });
  });

  test("absent when there is no setup-state file", () => {
    const result = classifyManagedProviderMachine("/data", enoent, "darwin");
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

  test("rejects on exit 125 when stderr does not indicate the machine is missing", async () => {
    const teardown = teardownManagedProviderMachine("/data", {
      classify: () => ({ ownership: "owned", name: "lando" }),
      spawn: async () => ({ exitCode: 125, stderr: "Error: permission denied" }),
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

  // Exercises the real (unseamed) spawn via a nested `bun` process so a large,
  // undrained stdout pipe would reproduce the hang this test guards against.
  // A stub `podman` on PATH must be resolved at the child's own startup (Bun.spawn
  // does not re-resolve PATH from live `process.env` mutations), and a POSIX
  // shebang script stands in for `podman`, so this is skipped on Windows.
  test.skipIf(process.platform === "win32")(
    "the default spawn drains stdout so a chatty podman cannot hang teardown",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "lando-podman-hang-"));
      const binDir = join(workDir, "bin");
      const userDataRoot = join(workDir, "data");
      await mkdir(binDir, { recursive: true });
      await mkdir(join(userDataRoot, "providers", "provider-lando"), { recursive: true });

      const podmanStub = join(binDir, "podman");
      // Bigger than a typical OS pipe buffer (64KiB): if defaultSpawn stopped
      // draining stdout, this write would block and proc.exited would never settle.
      await writeFile(podmanStub, "#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' 'a'\nexit 0\n", "utf-8");
      await chmod(podmanStub, 0o700);
      await writeFile(
        join(userDataRoot, "providers", "provider-lando", "setup-state.json"),
        JSON.stringify({ podmanVersion: "5.2.0", machine: { name: "lando", createdByLando: true } }),
        "utf-8",
      );

      const modulePath = join(
        dirname(import.meta.dir),
        "..",
        "src",
        "runtime",
        "managed-provider-machine.ts",
      );
      const script = join(workDir, "run-teardown.ts");
      await writeFile(
        script,
        `import { teardownManagedProviderMachine } from ${JSON.stringify(modulePath)};\nconsole.log(JSON.stringify(await teardownManagedProviderMachine(process.argv[2])));\n`,
        "utf-8",
      );

      try {
        const proc = Bun.spawn(["bun", script, userDataRoot], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        });
        const timedOut = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("teardown subprocess hung")), 8000);
        });
        const [stdout] = await Promise.race([
          Promise.all([new Response(proc.stdout).text(), proc.exited]),
          timedOut,
        ]);
        expect(JSON.parse(stdout)).toEqual({ removed: true, name: "lando" });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    10000,
  );
});
