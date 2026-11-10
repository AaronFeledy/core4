import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("PodmanServiceRunner", () => {
  test("buildPodmanServiceArgs emits canonical podman system service argv with private-root flags and unix socket bind", () => {
    const spec = buildPodmanServiceArgs({
      podmanBin: "/data/runtime/bin/podman",
      storageDir: "/data/runtime/storage",
      runRoot: "/data/runtime/run",
      configDir: "/data/runtime/config",
      socketPath: "/data/runtime/run/podman.sock",
      privateRuntimeDir: "/private/selected-runtime",
    });

    expect(spec.command).toBe("/data/runtime/bin/podman");
    expect(spec.env).toMatchObject({
      CONTAINERS_CONF: "/data/runtime/config/containers.conf",
      CONTAINERS_REGISTRIES_CONF: "/data/runtime/config/registries.conf",
      XDG_CONFIG_HOME: "/data/runtime/config",
      DISABLE_HC_SYSTEMD: "true",
      XDG_RUNTIME_DIR: "/private/selected-runtime",
    });
    expect(spec.env?.PATH?.startsWith("/data/runtime/bin")).toBe(true);
    expect(spec.cwd).toBe("/data/runtime/run");
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

  test("buildPodmanServiceArgs always prepends runtime/bin so netavark can find nft", () => {
    const spec = buildPodmanServiceArgs({
      podmanBin: "/data/runtime/bin/podman",
      storageDir: "/data/runtime/storage",
      runRoot: "/data/runtime/run",
      configDir: "/data/runtime/config",
      socketPath: "/data/runtime/run/podman.sock",
      privateRuntimeDir: undefined,
    });

    expect(spec.env?.PATH?.startsWith("/data/runtime/bin")).toBe(true);
    if (process.env.PATH !== undefined && process.env.PATH.length > 0) {
      expect(spec.env?.PATH).toContain(process.env.PATH);
    }
  });

  test("isManagedPodmanServiceArgv matches canonical and legacy argv without storage-opt", () => {
    const spec = buildPodmanServiceArgs({
      podmanBin: "/data/runtime/bin/podman",
      storageDir: "/data/runtime/storage",
      runRoot: "/data/runtime/run",
      configDir: "/data/runtime/config",
      socketPath: "/data/runtime/run/podman.sock",
      privateRuntimeDir: undefined,
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
      privateRuntimeDir: undefined,
    });

    expect(spec.args).toContain("--time=0");
    expect(spec.args.at(-1)).toBe("unix:///data/runtime/run/podman.sock");
  });

  test("system runner launches Podman with managed config and runtime bin prepended to PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-podman-service-runner-"));
    const previousHost = process.env.CONTAINER_HOST;
    process.env.CONTAINER_HOST = "unix:///hostile.sock";
    try {
      let launchedEnv: Readonly<Record<string, string | undefined>> | undefined;
      let launchedCwd: string | undefined;
      const runner = makeSystemPodmanServiceRunner(
        (_argv, options) => {
          launchedEnv = options.env;
          launchedCwd = options.cwd;
          return { pid: 4321 };
        },
        (_runtimeDir, resolved) => Effect.succeed(resolved.privateRuntimeDir ?? "/wrong/runtime"),
      );
      const runRoot = join(dir, "run");
      const spec = buildPodmanServiceArgs({
        podmanBin: "/data/runtime/bin/podman",
        storageDir: "/data/runtime/storage",
        runRoot,
        configDir: "/data/runtime/config",
        socketPath: join(dir, "podman.sock"),
        privateRuntimeDir: "/private/test-runtime",
      });

      const pid = await Effect.runPromise(runner.launch(spec));

      expect(pid).toBe(4321);
      expect(launchedEnv?.CONTAINERS_CONF).toBe("/data/runtime/config/containers.conf");
      expect(launchedEnv?.CONTAINERS_REGISTRIES_CONF).toBe("/data/runtime/config/registries.conf");
      expect(launchedEnv?.XDG_CONFIG_HOME).toBe("/data/runtime/config");
      expect(launchedEnv?.XDG_RUNTIME_DIR).toBe("/private/test-runtime");
      expect(launchedEnv?.CONTAINER_HOST).toBeUndefined();
      expect(launchedEnv?.PATH?.startsWith("/data/runtime/bin")).toBe(true);
      expect(launchedCwd).toBe(runRoot);
      if (process.env.PATH !== undefined && process.env.PATH.length > 0) {
        expect(launchedEnv?.PATH).toContain(process.env.PATH);
      }
    } finally {
      if (previousHost === undefined) Reflect.deleteProperty(process.env, "CONTAINER_HOST");
      else process.env.CONTAINER_HOST = previousHost;
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
      const pid = await Effect.runPromise(runner.launch(spec));
      await Effect.runPromise(runner.waitForExit?.(pid) ?? Effect.die("exit observer missing"));

      // Then: stderr lands in the fresh service log next to the runtime socket.
      const content = await readFile(podmanServiceLogPath(spec.socketPath), "utf8");
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
      const pid = await Effect.runPromise(runner.launch(spec));
      await Effect.runPromise(runner.waitForExit?.(pid) ?? Effect.die("exit observer missing"));

      // Then: the log contains only the new launch evidence.
      const content = await readFile(logPath, "utf8");
      expect(content).toContain("fresh");
      expect(content).not.toContain("old failure");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a delegated launch wraps the exact service argv and keeps the launched PID through the exec chain", async () => {
    // Given: a stand-in launcher that, like `systemd-run --scope`, records its environment and
    // execs the command after `--` in the same process.
    const dir = await mkdtemp(join(tmpdir(), "lando-podman-scope-launch-"));
    const launcher = join(dir, "systemd-run");
    const launcherEnv = join(dir, "launcher.env");
    await writeFile(
      launcher,
      `#!/bin/sh\nenv > '${launcherEnv}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
    );
    await chmod(launcher, 0o755);
    const runRoot = join(dir, "run");
    const ready = join(dir, "ready.fifo");
    await Bun.$`mkfifo ${ready}`;
    const spec = {
      command: "/bin/sh",
      args: ["-c", 'echo ready > "$1"; while :; do sleep 1; done', "sh", ready, "--runroot", runRoot],
      env: { XDG_RUNTIME_DIR: "/private/scope-runtime", DISABLE_HC_SYSTEMD: "true" },
      socketPath: join(dir, "podman.sock"),
    };
    let launchedArgv: ReadonlyArray<string> = [];
    const runner = makeSystemPodmanServiceRunner(
      (argv, options) => {
        launchedArgv = argv;
        return Bun.spawn([...argv], options);
      },
      (_runtimeDir, resolved) => Effect.succeed(resolved.privateRuntimeDir ?? "/wrong"),
      () => Effect.succeed(255),
    );
    const previousBus = process.env.DBUS_SESSION_BUS_ADDRESS;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/4242/bus";
    try {
      // When: the launcher hands over to the service, which then reports ready.
      const pid = await Effect.runPromise(
        runner.launch(spec, { systemdRun: launcher, userRuntimeDir: "/run/user/4242" }),
      );
      expect((await readFile(ready, "utf8")).trim()).toBe("ready");

      // Then: the launcher is the outer argv, `env` restores the private dir, then the exact argv.
      expect(launchedArgv).toEqual([
        launcher,
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "-p",
        "Delegate=yes",
        "--expand-environment=no",
        "--description=Lando managed Podman runtime",
        "--",
        "/usr/bin/env",
        "XDG_RUNTIME_DIR=/private/scope-runtime",
        spec.command,
        ...spec.args,
      ]);
      expect(await Effect.runPromise(runner.isServiceProcess?.(pid, spec) ?? Effect.succeed(false))).toBe(true);
      const environ = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
      expect(environ).toContain("XDG_RUNTIME_DIR=/private/scope-runtime");
      const outer = await readFile(launcherEnv, "utf8");
      expect(outer).toContain("XDG_RUNTIME_DIR=/run/user/4242");
      expect(outer).not.toContain("DBUS_SESSION_BUS_ADDRESS");

      // And the exit observer still belongs to the launched PID.
      await Effect.runPromise(runner.terminate(pid));
      expect(await Effect.runPromise(runner.waitForExit?.(pid) ?? Effect.die("exit observer missing"))).not.toBe(0);
    } finally {
      if (previousBus === undefined) Reflect.deleteProperty(process.env, "DBUS_SESSION_BUS_ADDRESS");
      else process.env.DBUS_SESSION_BUS_ADDRESS = previousBus;
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
