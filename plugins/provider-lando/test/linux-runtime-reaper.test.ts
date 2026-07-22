import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Duration, Effect, Exit } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { reapStaleLinuxRuntime } from "../src/linux-runtime-reaper.ts";
import type { PodmanServiceRunner } from "../src/podman-service-runner.ts";

const paths = (dir: string) => {
  const runtimeRoot = join(dir, "runtime");
  const runRoot = join(runtimeRoot, "run");
  return {
    podmanBin: join(runtimeRoot, "bin", "podman"),
    storageDir: join(runtimeRoot, "storage"),
    runRoot,
    configDir: join(runtimeRoot, "config"),
    socketPath: join(runRoot, "podman.sock"),
    pidPath: join(runRoot, "podman.pid"),
  };
};

const runner = (
  options: {
    readonly pids?: ReadonlyArray<number>;
    readonly isAlive?: (pid: number) => boolean;
    readonly isServiceProcess?: (pid: number) => boolean;
    readonly terminate?: PodmanServiceRunner["terminate"];
  } = {},
): PodmanServiceRunner => ({
  launch: () => Effect.succeed(9999),
  isAlive: (pid) => Effect.sync(() => options.isAlive?.(pid) ?? false),
  isServiceProcess: (pid) => Effect.sync(() => options.isServiceProcess?.(pid) ?? false),
  findMatchingServicePids: () => Effect.succeed(options.pids ?? []),
  findManagedServicePids: () => Effect.succeed(options.pids ?? []),
  terminate: options.terminate ?? ((_pid, _spec) => Effect.void),
});

const bootIdReader = (bootId: string) => () => Effect.succeed(bootId);
const pidNamespaceReader = (pidNamespace: string) => () => Effect.succeed(pidNamespace);
const generation = (bootId: string, pidNamespace = "pid:[100]") => `${bootId}\n${pidNamespace}`;
const generationReaders = (bootId: string, pidNamespace = "pid:[100]") => ({
  bootIdReader: bootIdReader(bootId),
  pidNamespaceReader: pidNamespaceReader(pidNamespace),
});

describe("reapStaleLinuxRuntime", () => {
  test("resets runRoot when the PID namespace changes within the same kernel boot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-linux-reaper-"));
    try {
      // Given: WSL recreated the distro PID namespace without rebooting its shared kernel.
      const p = paths(dir);
      await mkdir(p.runRoot, { recursive: true });
      await writeFile(join(p.runRoot, "stale"), "stale");
      await writeFile(`${p.runRoot}.generation`, "boot-1\npid:[100]");

      // When: cleanup observes the same boot id and a new PID namespace.
      await Effect.runPromise(
        reapStaleLinuxRuntime({
          ...p,
          serviceRunner: runner(),
          ...generationReaders("boot-1", "pid:[200]"),
        }),
      );

      // Then: transient run state is reset and the complete generation advances.
      expect(await readdir(p.runRoot)).toEqual([]);
      expect(await readFile(`${p.runRoot}.generation`, "utf8")).toBe("boot-1\npid:[200]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resets nested runRoot residue when the kernel boot id changes and preserves durable siblings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-linux-reaper-"));
    try {
      // Given: runtime residue and a marker from the previous boot.
      const p = paths(dir);
      const residue = join(p.runRoot, "networks", "aardvark-dns", "ipam", "netns", "state");
      await mkdir(residue, { recursive: true });
      await mkdir(p.storageDir, { recursive: true });
      await mkdir(p.configDir, { recursive: true });
      await writeFile(join(residue, "stale"), "stale");
      await writeFile(join(p.storageDir, "sentinel"), "storage");
      await writeFile(join(p.configDir, "sentinel"), "config");
      await writeFile(`${p.runRoot}.generation`, generation("boot-1"));

      // When: cleanup observes a new host boot.
      await Effect.runPromise(
        reapStaleLinuxRuntime({ ...p, serviceRunner: runner(), ...generationReaders("boot-2") }),
      );

      // Then: only runRoot is recreated and the sibling marker advances.
      expect(await readdir(p.runRoot)).toEqual([]);
      expect(await readFile(`${p.runRoot}.generation`, "utf8")).toBe(generation("boot-2"));
      expect(await readFile(join(p.storageDir, "sentinel"), "utf8")).toBe("storage");
      expect(await readFile(join(p.configDir, "sentinel"), "utf8")).toBe("config");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves runRoot residue on a same-boot API-service crash and removes only launch metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-linux-reaper-"));
    try {
      // Given: same-boot runtime state with stale API-service metadata.
      const p = paths(dir);
      const residue = join(p.runRoot, "networks", "aardvark-dns", "state");
      await mkdir(residue, { recursive: true });
      await writeFile(join(residue, "preserve"), "same-boot");
      await writeFile(p.socketPath, "socket");
      await writeFile(p.pidPath, "invalid");
      await writeFile(`${p.pidPath}.launch.json`, "{}");
      await writeFile(`${p.runRoot}.generation`, generation("boot-1"));

      // When: cleanup observes the same host boot.
      await Effect.runPromise(
        reapStaleLinuxRuntime({ ...p, serviceRunner: runner(), ...generationReaders("boot-1") }),
      );

      // Then: runtime state survives while stale launch metadata is removed.
      expect(await readFile(join(residue, "preserve"), "utf8")).toBe("same-boot");
      expect(await readdir(p.runRoot)).toEqual(["networks"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("treats a missing runtime generation marker as requiring runRoot reset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-linux-reaper-"));
    try {
      // Given: stale runRoot state has no boot marker.
      const p = paths(dir);
      await mkdir(p.runRoot, { recursive: true });
      await writeFile(join(p.runRoot, "stale"), "stale");

      // When: cleanup reads the current boot id.
      await Effect.runPromise(
        reapStaleLinuxRuntime({ ...p, serviceRunner: runner(), ...generationReaders("boot-1") }),
      );

      // Then: runRoot is recreated and initialized for this boot.
      expect(await readdir(p.runRoot)).toEqual([]);
      expect(await readFile(`${p.runRoot}.generation`, "utf8")).toBe(generation("boot-1"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an invalid destructive layout without deleting runRoot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-linux-reaper-"));
    try {
      // Given: the recursive target does not have the production run leaf.
      const p = { ...paths(dir), runRoot: join(dir, "unsafe") };
      await mkdir(p.runRoot, { recursive: true });
      const sentinel = join(p.runRoot, "preserve");
      await writeFile(sentinel, "safe");

      // When: a boot change would otherwise request recursive deletion.
      const exit = await Effect.runPromiseExit(
        reapStaleLinuxRuntime({ ...p, serviceRunner: runner(), ...generationReaders("boot-2") }),
      );

      // Then: validation fails with a tagged error before deletion.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(await readFile(sentinel, "utf8")).toBe("safe");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("surfaces generation and runRoot reset failures as tagged provider errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-linux-reaper-"));
    try {
      const p = paths(dir);
      const bootExit = await Effect.runPromiseExit(
        reapStaleLinuxRuntime({
          ...p,
          serviceRunner: runner(),
          bootIdReader: () => Effect.fail(new Error("boot unavailable")),
          pidNamespaceReader: pidNamespaceReader("pid:[100]"),
        }),
      );
      const namespaceExit = await Effect.runPromiseExit(
        reapStaleLinuxRuntime({
          ...p,
          serviceRunner: runner(),
          bootIdReader: bootIdReader("boot-2"),
          pidNamespaceReader: () => Effect.fail(new Error("namespace unavailable")),
        }),
      );
      const resetExit = await Effect.runPromiseExit(
        reapStaleLinuxRuntime({
          ...p,
          serviceRunner: runner(),
          ...generationReaders("boot-2"),
          filesystem: {
            readFile: (path: string) => Effect.tryPromise(() => readFile(path, "utf8")),
            removeFile: (path: string) => Effect.tryPromise(() => rm(path, { force: true })),
            resetRunRoot: () => Effect.fail(new Error("reset denied")),
            writeFile: (path: string, content: string) => Effect.tryPromise(() => writeFile(path, content)),
          },
        }),
      );

      for (const exit of [bootExit, namespaceExit, resetExit]) {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause);
          expect(failure._tag).toBe("Some");
          if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("waits for managed identity disappearance after termination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-linux-reaper-"));
    try {
      // Given: a managed process remains visible briefly after SIGTERM.
      const p = paths(dir);
      await mkdir(p.runRoot, { recursive: true });
      await writeFile(`${p.runRoot}.generation`, generation("boot-1"));
      let identityChecks = 0;
      const calls: number[] = [];

      // When: cleanup terminates and probes for quiescence.
      await Effect.runPromise(
        reapStaleLinuxRuntime({
          ...p,
          serviceRunner: runner({
            pids: [4321],
            isAlive: () => true,
            isServiceProcess: () => {
              identityChecks += 1;
              return identityChecks < 3;
            },
            terminate: (pid, _spec) => Effect.sync(() => calls.push(pid)).pipe(Effect.asVoid),
          }),
          ...generationReaders("boot-1"),
          terminationPolicy: { maxAttempts: 5, delay: Duration.millis(1), timeout: Duration.millis(50) },
        }),
      );

      // Then: termination happens once and cleanup waits beyond the first identity check.
      expect(calls).toEqual([4321]);
      expect(identityChecks).toBeGreaterThanOrEqual(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("termination failure prevents metadata cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-linux-reaper-"));
    try {
      // Given: a managed process whose signal operation fails.
      const p = paths(dir);
      await mkdir(p.runRoot, { recursive: true });
      await writeFile(p.socketPath, "preserve");
      await writeFile(`${p.runRoot}.generation`, generation("boot-1"));

      // When: cleanup cannot terminate the process.
      const exit = await Effect.runPromiseExit(
        reapStaleLinuxRuntime({
          ...p,
          serviceRunner: runner({
            pids: [4321],
            isAlive: () => true,
            isServiceProcess: () => true,
            terminate: (_pid, _spec) =>
              Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "setup",
                  message: "signal failed",
                  remediation: "retry",
                }),
              ),
          }),
          ...generationReaders("boot-1"),
        }),
      );

      // Then: failure is tagged and destructive cleanup has not started.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(await readFile(p.socketPath, "utf8")).toBe("preserve");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("termination timeout is tagged and prevents metadata cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-linux-reaper-"));
    try {
      // Given: SIGTERM succeeds but managed identity never disappears.
      const p = paths(dir);
      await mkdir(p.runRoot, { recursive: true });
      await writeFile(p.socketPath, "preserve");
      await writeFile(`${p.runRoot}.generation`, generation("boot-1"));

      // When: the bounded quiescence probe exhausts its policy.
      const exit = await Effect.runPromiseExit(
        reapStaleLinuxRuntime({
          ...p,
          serviceRunner: runner({
            pids: [4321],
            isAlive: () => true,
            isServiceProcess: () => true,
          }),
          ...generationReaders("boot-1"),
          terminationPolicy: { maxAttempts: 2, delay: Duration.millis(1), timeout: Duration.millis(20) },
        }),
      );

      // Then: timeout remains a tagged provider failure and cleanup has not started.
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
      }
      expect(await readFile(p.socketPath, "utf8")).toBe("preserve");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
