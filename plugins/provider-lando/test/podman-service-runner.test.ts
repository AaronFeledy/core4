import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import {
  type PodmanServiceRunner,
  buildPodmanServiceArgs,
  isManagedPodmanServiceArgv,
  makeSystemPodmanServiceRunner,
  podmanServiceLogPath,
} from "../src/podman-service-runner.ts";

const waitForLog = async (path: string, expected: string): Promise<string> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.includes(expected)) return content;
    await Bun.sleep(25);
  }
  return readFile(path, "utf8");
};

describe("PodmanServiceRunner", () => {
  test("buildPodmanServiceArgs emits canonical podman system service argv with private-root flags and unix socket bind", () => {
    const spec = buildPodmanServiceArgs({
      podmanBin: "/data/runtime/bin/podman",
      storageDir: "/data/runtime/storage",
      runRoot: "/data/runtime/run",
      configDir: "/data/runtime/config",
      socketPath: "/data/runtime/run/podman.sock",
    });

    expect(spec.command).toBe("/data/runtime/bin/podman");
    expect(spec.env).toEqual({
      CONTAINERS_CONF: "/data/runtime/config/containers.conf",
      CONTAINERS_REGISTRIES_CONF: "/data/runtime/config/registries.conf",
      XDG_CONFIG_HOME: "/data/runtime/config",
    });
    expect(spec.env).not.toHaveProperty("PATH");
    expect(spec.args).toEqual([
      "--root",
      "/data/runtime/storage",
      "--runroot",
      "/data/runtime/run",
      "--config",
      "/data/runtime/config",
      "--storage-opt",
      "overlay.mount_program=/data/runtime/bin/fuse-overlayfs",
      "system",
      "service",
      "--time=0",
      "unix:///data/runtime/run/podman.sock",
    ]);
    expect(spec.socketPath).toBe("/data/runtime/run/podman.sock");
  });

  test("isManagedPodmanServiceArgv matches canonical and legacy argv without storage-opt", () => {
    const spec = buildPodmanServiceArgs({
      podmanBin: "/data/runtime/bin/podman",
      storageDir: "/data/runtime/storage",
      runRoot: "/data/runtime/run",
      configDir: "/data/runtime/config",
      socketPath: "/data/runtime/run/podman.sock",
    });
    const canonical = [spec.command, ...spec.args];
    const legacy = [
      spec.command,
      "--root",
      "/data/runtime/storage",
      "--runroot",
      "/data/runtime/run",
      "--config",
      "/data/runtime/config",
      "system",
      "service",
      "--time=0",
      "unix:///data/runtime/run/podman.sock",
    ];

    expect(isManagedPodmanServiceArgv(canonical, spec)).toBe(true);
    expect(isManagedPodmanServiceArgv(legacy, spec)).toBe(true);
    expect(
      isManagedPodmanServiceArgv(
        [
          spec.command,
          "--root",
          "/other",
          "--runroot",
          "/data/runtime/run",
          "--config",
          "/data/runtime/config",
          "system",
          "service",
          "--time=0",
          "unix:///data/runtime/run/podman.sock",
        ],
        spec,
      ),
    ).toBe(false);
  });

  test("buildPodmanServiceArgs binds unix://<socketPath> and keeps the service alive with --time=0", () => {
    const spec = buildPodmanServiceArgs({
      podmanBin: "/data/runtime/bin/podman",
      storageDir: "/data/runtime/storage",
      runRoot: "/data/runtime/run",
      configDir: "/data/runtime/config",
      socketPath: "/data/runtime/run/podman.sock",
    });

    expect(spec.args).toContain("--time=0");
    expect(spec.args.at(-1)).toBe("unix:///data/runtime/run/podman.sock");
  });

  test("system runner launches Podman with managed config and the inherited host PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-podman-service-runner-"));
    try {
      let launchedEnv: Readonly<Record<string, string | undefined>> | undefined;
      const runner = makeSystemPodmanServiceRunner((_argv, options) => {
        launchedEnv = options.env;
        return { pid: 4321 };
      });
      const spec = buildPodmanServiceArgs({
        podmanBin: "/data/runtime/bin/podman",
        storageDir: "/data/runtime/storage",
        runRoot: "/data/runtime/run",
        configDir: "/data/runtime/config",
        socketPath: join(dir, "podman.sock"),
      });

      const pid = await Effect.runPromise(runner.launch(spec));

      expect(pid).toBe(4321);
      expect(launchedEnv?.CONTAINERS_CONF).toBe("/data/runtime/config/containers.conf");
      expect(launchedEnv?.CONTAINERS_REGISTRIES_CONF).toBe("/data/runtime/config/registries.conf");
      expect(launchedEnv?.XDG_CONFIG_HOME).toBe("/data/runtime/config");
      expect(launchedEnv?.PATH).toBe(process.env.PATH);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("system runner writes managed service output to a service log", async () => {
    // Given: a managed service command that writes startup evidence to stderr.
    const dir = await mkdtemp(join(tmpdir(), "lando-podman-service-runner-"));
    try {
      const runner = makeSystemPodmanServiceRunner();
      const spec = {
        command: "/bin/sh",
        args: ["-c", "echo boom >&2; exit 1"],
        socketPath: join(dir, "podman.sock"),
      };

      // When: the service is launched by the system runner.
      await Effect.runPromise(runner.launch(spec));

      // Then: stderr lands in the fresh service log next to the runtime socket.
      const content = await waitForLog(podmanServiceLogPath(spec.socketPath), "boom");
      expect(content).toContain("boom");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("system runner truncates the service log for each fresh launch", async () => {
    // Given: a previous service log contains stale startup evidence.
    const dir = await mkdtemp(join(tmpdir(), "lando-podman-service-runner-"));
    try {
      const runner = makeSystemPodmanServiceRunner();
      const socketPath = join(dir, "podman.sock");
      const logPath = podmanServiceLogPath(socketPath);
      await writeFile(logPath, "old failure\n");
      const spec = {
        command: "/bin/sh",
        args: ["-c", "echo fresh >&2; exit 1"],
        socketPath,
      };

      // When: a new service launch starts.
      await Effect.runPromise(runner.launch(spec));

      // Then: the log contains only the new launch evidence.
      const content = await waitForLog(logPath, "fresh");
      expect(content).toContain("fresh");
      expect(content).not.toContain("old failure");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("PodmanServiceRunner interface is usable with a fake runner", async () => {
    const fakeRunner: PodmanServiceRunner = {
      launch: () => Effect.succeed(4321),
      isAlive: () => Effect.succeed(true),
      terminate: () => Effect.void,
    };

    const pid = await Effect.runPromise(
      fakeRunner.launch({
        command: "/data/runtime/bin/podman",
        args: ["system", "service", "--time=0", "unix:///data/runtime/run/podman.sock"],
        socketPath: "/data/runtime/run/podman.sock",
      }),
    );
    const isAlive = await Effect.runPromise(fakeRunner.isAlive(4321));
    const terminateResult = await Effect.runPromise(fakeRunner.terminate(4321));

    expect(pid).toBe(4321);
    expect(isAlive).toBe(true);
    expect(terminateResult).toBeUndefined();
  });
});
