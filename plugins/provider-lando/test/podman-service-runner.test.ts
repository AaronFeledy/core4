import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { type PodmanServiceRunner, buildPodmanServiceArgs } from "../src/podman-service-runner.ts";

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
    expect(spec.args).toEqual([
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
    ]);
    expect(spec.socketPath).toBe("/data/runtime/run/podman.sock");
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
