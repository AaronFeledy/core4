import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Duration, Effect } from "effect";

import type { PodmanApiClient } from "../src/capabilities.ts";
import { ensureRuntime } from "../src/ensure-runtime.ts";
import type { LinuxRuntimeFilesystem, RuntimeGenerationStore } from "../src/linux-runtime-generation.ts";
import { type PodmanServiceRunner, buildPodmanServiceArgs } from "../src/podman-service-runner.ts";

const paths = (dir: string) => {
  const runtime = join(dir, "runtime");
  const runRoot = join(runtime, "run");
  return {
    podmanBin: join(runtime, "bin", "podman"),
    storageDir: join(runtime, "storage"),
    runRoot,
    configDir: join(runtime, "config"),
    socketPath: join(runRoot, "podman.sock"),
    pidPath: join(runRoot, "podman.pid"),
  };
};

const writeOwnedLaunch = async (runtimePaths: ReturnType<typeof paths>, pid: number): Promise<void> => {
  const spec = buildPodmanServiceArgs(runtimePaths);
  await mkdir(runtimePaths.runRoot, { recursive: true });
  await writeFile(runtimePaths.pidPath, String(pid));
  await writeFile(`${runtimePaths.pidPath}.launch.json`, JSON.stringify({ pid, env: spec.env }));
};

const generationStore = (initial: string | null, events: string[]) => {
  let marker = initial;
  const store: RuntimeGenerationStore = {
    get: Effect.sync(() => marker),
    set: (value) =>
      Effect.sync(() => {
        marker = value;
        events.push(`marker:${value}`);
      }),
  };
  return { store, marker: () => marker };
};

const filesystem = (events: string[]): LinuxRuntimeFilesystem => ({
  removeFile: (path) => Effect.sync(() => events.push(`remove:${path}`)).pipe(Effect.asVoid),
  resetRunRoot: (path) => Effect.sync(() => events.push(`reset:${path}`)).pipe(Effect.asVoid),
});

describe("managed Linux runtime generation recovery", () => {
  test("a healthy runtime adopts a missing generation marker without resetting runroot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-generation-adopt-"));
    try {
      const runtimePaths = paths(dir);
      const events: string[] = [];
      const generation = generationStore(null, events);
      await writeOwnedLaunch(runtimePaths, 4100);
      const serviceRunner: PodmanServiceRunner = {
        launch: () => Effect.die("healthy runtime must not launch"),
        isAlive: () => Effect.succeed(true),
        isServiceProcess: () => Effect.succeed(true),
        terminate: () => Effect.die("healthy runtime must not terminate"),
      };
      const podmanApi: PodmanApiClient = { info: Effect.succeed({}), ping: Effect.void };

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi,
          serviceRunner,
          generationStore: generation.store,
          bootIdReader: () => Effect.succeed("boot-a"),
          pidNamespaceReader: () => Effect.succeed("pid:[1]"),
          filesystem: filesystem(events),
          ...runtimePaths,
        }),
      );

      expect(generation.marker()).toBe("boot-a\npid:[1]");
      expect(events).toEqual(["marker:boot-a\npid:[1]"]);
      expect(await readFile(runtimePaths.pidPath, "utf8")).toBe("4100");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a changed generation terminates managed pids before resetting only runroot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-generation-reset-"));
    try {
      const runtimePaths = paths(dir);
      const events: string[] = [];
      const generation = generationStore("boot-old\npid:[9]", events);
      let alive = true;
      await writeOwnedLaunch(runtimePaths, 4200);
      const serviceRunner: PodmanServiceRunner = {
        launch: () =>
          Effect.sync(() => {
            alive = true;
            events.push("launch");
            return 4300;
          }),
        isAlive: () => Effect.succeed(alive),
        isServiceProcess: () => Effect.succeed(alive),
        terminate: (pid) =>
          Effect.sync(() => {
            alive = false;
            events.push(`terminate:${pid}`);
          }),
      };
      const podmanApi: PodmanApiClient = { info: Effect.succeed({}), ping: Effect.void };

      await Effect.runPromise(
        ensureRuntime({
          platform: "linux",
          podmanApi,
          serviceRunner,
          generationStore: generation.store,
          bootIdReader: () => Effect.succeed("boot-new"),
          pidNamespaceReader: () => Effect.succeed("pid:[1]"),
          filesystem: filesystem(events),
          terminationPolicy: {
            maxAttempts: 2,
            delay: Duration.millis(1),
            timeout: Duration.millis(20),
          },
          ...runtimePaths,
        }),
      );

      expect(events.indexOf("terminate:4200")).toBeLessThan(events.indexOf(`reset:${runtimePaths.runRoot}`));
      expect(events.indexOf(`reset:${runtimePaths.runRoot}`)).toBeLessThan(events.indexOf("launch"));
      expect(events.filter((event) => event.startsWith("reset:"))).toEqual([`reset:${runtimePaths.runRoot}`]);
      expect(generation.marker()).toBe("boot-new\npid:[1]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
