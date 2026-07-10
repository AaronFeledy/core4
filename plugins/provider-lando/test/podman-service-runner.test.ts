import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  type PodmanServiceRunner,
  buildPodmanServiceArgs,
  isManagedPodmanServiceArgv,
  makeSystemPodmanServiceRunner,
} from "../src/podman-service-runner.ts";

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
    expect(spec.env).toEqual({ CONTAINERS_CONF: "/data/runtime/config/containers.conf" });
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

  test("system runner launches Podman with the managed containers config and inherited environment", async () => {
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
      socketPath: "/data/runtime/run/podman.sock",
    });

    const pid = await Effect.runPromise(runner.launch(spec));

    expect(pid).toBe(4321);
    expect(launchedEnv?.CONTAINERS_CONF).toBe("/data/runtime/config/containers.conf");
    expect(launchedEnv?.PATH).toBe(process.env.PATH);
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
