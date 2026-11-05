import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect } from "effect";
import {
  type UninstallRuntime,
  type UninstallRuntimeSeams,
  defaultRuntimeExec,
  runUninstallRuntime,
  uninstallRuntimes,
} from "../../src/install/uninstall-runtime.ts";

const inspectScript = `process.stdout.write(JSON.stringify({
  argv: process.argv.slice(1),
  env: {
    LANDO_USER_DATA_ROOT: process.env.LANDO_USER_DATA_ROOT,
    CONTAINER_HOST: process.env.CONTAINER_HOST,
    CONTAINERS_CONF_OVERRIDE: process.env.CONTAINERS_CONF_OVERRIDE,
    HOME: process.env.HOME,
    CONTAINERS_CONF: process.env.CONTAINERS_CONF,
    CONTAINERS_REGISTRIES_CONF: process.env.CONTAINERS_REGISTRIES_CONF,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DISABLE_HC_SYSTEMD: process.env.DISABLE_HC_SYSTEMD,
    LANDO_MANAGED_CONFIG_REVISION: process.env.LANDO_MANAGED_CONFIG_REVISION,
    PATH: process.env.PATH,
  },
}));`;

const failedScript = `process.stdout.write("probe marker\\n"); process.exitCode = 7;`;

const privateRuntimeDir = "/tmp/lando-test-private-runtime";

const fixture = (script: string) => {
  const root = mkdtempSync(join(tmpdir(), "lando runtime adapter "));
  const data = join(root, "data root");
  const config = join(data, "runtime", "config");
  const bin = join(data, "runtime", "bin");
  const runtimeDir = join(data, "runtime");
  const overlay = {
    CONTAINERS_CONF: join(config, "containers.conf"),
    CONTAINERS_REGISTRIES_CONF: join(config, "registries.conf"),
    XDG_CONFIG_HOME: config,
    DISABLE_HC_SYSTEMD: "true",
    LANDO_MANAGED_CONFIG_REVISION: "2-native-init",
    PATH: bin,
  };
  const prepareCalls: string[] = [];
  const runtime: UninstallRuntime = {
    cmd: process.execPath,
    providerId: "lando",
    managed: true,
    managedSpawn: "linux",
    runtimeDir,
    argsPrefix: ["--eval", script, "--", "prefix marker"],
    env: overlay,
  };
  const seams: UninstallRuntimeSeams = {
    hostEnv: {
      HOME: "/home/fixture",
      CONTAINER_HOST: "unix:///hostile.sock",
      CONTAINERS_CONF_OVERRIDE: "/hostile/override.conf",
      LANDO_USER_DATA_ROOT: data,
      PATH: "/usr/bin",
    },
    prepareRuntimeDir: (dir) => {
      prepareCalls.push(dir);
      return Effect.succeed(privateRuntimeDir);
    },
  };
  return {
    runtime,
    overlay,
    seams,
    bin,
    runtimeDir,
    prepareCalls,
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
};

test("default runtime adapter preserves argv, managed child env, and stdout", async () => {
  using f = fixture(inspectScript);
  const args = ["app with spaces", 'quote"inside', ""];

  const result = await runUninstallRuntime(defaultRuntimeExec, f.runtime, { args }, f.seams);

  expect(JSON.parse(result.stdout)).toEqual({
    argv: ["prefix marker", ...args],
    env: {
      LANDO_USER_DATA_ROOT: undefined,
      CONTAINER_HOST: undefined,
      CONTAINERS_CONF_OVERRIDE: undefined,
      HOME: "/home/fixture",
      CONTAINERS_CONF: f.overlay.CONTAINERS_CONF,
      CONTAINERS_REGISTRIES_CONF: f.overlay.CONTAINERS_REGISTRIES_CONF,
      XDG_CONFIG_HOME: f.overlay.XDG_CONFIG_HOME,
      XDG_RUNTIME_DIR: privateRuntimeDir,
      DISABLE_HC_SYSTEMD: "true",
      LANDO_MANAGED_CONFIG_REVISION: "2-native-init",
      PATH: `${f.bin}${delimiter}/usr/bin`,
    },
  });
  expect(f.prepareCalls).toEqual([f.runtimeDir]);
}, 10_000);

test("default runtime adapter preserves nonzero exit and captured stdout", async () => {
  using f = fixture(failedScript);

  const failure = await runUninstallRuntime(
    defaultRuntimeExec,
    f.runtime,
    {
      args: ["request marker"],
    },
    f.seams,
  ).then(
    () => new Error("expected runtime child to fail"),
    (cause: unknown) => cause,
  );

  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw failure;
  expect((failure as Error & { code?: number }).code).toBe(7);
  expect((failure as Error & { stdout?: string }).stdout).toBe("probe marker\n");
  expect(f.prepareCalls).toEqual([f.runtimeDir]);
}, 10_000);

test("runUninstallRuntime prepares the private runtime dir before every managed Linux spawn", async () => {
  using f = fixture(inspectScript);
  const order: string[] = [];
  const exec = async () => {
    order.push("exec");
    return { stdout: "{}" };
  };
  const seams: UninstallRuntimeSeams = {
    ...f.seams,
    prepareRuntimeDir: (dir) => {
      order.push(`prepare:${dir}`);
      return Effect.succeed(privateRuntimeDir);
    },
  };

  await runUninstallRuntime(exec, f.runtime, { args: ["ps"] }, seams);

  expect(order).toEqual([`prepare:${f.runtimeDir}`, "exec"]);
});

test("connection spawn strips redirects and never applies Linux config overlay", async () => {
  const hostEnv = {
    HOME: "/home/fixture",
    PATH: "/usr/bin",
    CONTAINER_HOST: "unix:///hostile.sock",
    CONTAINERS_CONF_OVERRIDE: "/evil.conf",
    _PODMAN_PAUSE: "1",
  };
  const runtime: UninstallRuntime = {
    cmd: process.execPath,
    providerId: "lando",
    managed: true,
    managedSpawn: "connection",
    argsPrefix: ["--eval", inspectScript, "--", "conn"],
  };
  const prepareCalls: string[] = [];
  const result = await runUninstallRuntime(
    defaultRuntimeExec,
    runtime,
    { args: [] },
    {
      hostEnv,
      prepareRuntimeDir: (dir) => {
        prepareCalls.push(dir);
        return Effect.succeed(privateRuntimeDir);
      },
    },
  );
  const env = JSON.parse(result.stdout).env as Record<string, string | undefined>;
  expect(env.CONTAINER_HOST).toBeUndefined();
  expect(env.CONTAINERS_CONF_OVERRIDE).toBeUndefined();
  expect(env.CONTAINERS_CONF).toBeUndefined();
  expect(env.XDG_CONFIG_HOME).toBeUndefined();
  expect(env.XDG_RUNTIME_DIR).toBeUndefined();
  expect(env.DISABLE_HC_SYSTEMD).toBeUndefined();
  expect(env.HOME).toBe("/home/fixture");
  expect(env.PATH).toBe("/usr/bin");
  expect(prepareCalls).toEqual([]);
}, 10_000);

test("uninstallRuntimes uses connection spawn on darwin and win32, linux only on linux", () => {
  const root = "/tmp/lando-uninstall-runtimes-root";
  const linux = uninstallRuntimes(root, "linux", { PATH: "/usr/bin" });
  const darwin = uninstallRuntimes(root, "darwin", { PATH: "/usr/bin", CONTAINER_HOST: "x" });
  const win32 = uninstallRuntimes(root, "win32", { PATH: "/usr/bin", CONTAINER_HOST: "x" });
  const managedLinux = linux.find((r) => r.managed);
  const managedDarwin = darwin.find((r) => r.managed);
  const managedWin = win32.find((r) => r.managed);
  if (managedLinux === undefined || managedDarwin === undefined || managedWin === undefined)
    throw new Error("managed runtime fixture missing");
  expect(managedLinux.managedSpawn).toBe("linux");
  expect(managedLinux.runtimeDir).toBeDefined();
  expect(managedLinux.argsPrefix[0]).toBe("--root");
  expect(managedLinux.env?.CONTAINERS_CONF).toContain("containers.conf");
  expect(managedDarwin.managedSpawn).toBe("connection");
  expect(managedDarwin.runtimeDir).toBeUndefined();
  expect(managedDarwin.env).toBeUndefined();
  expect(managedDarwin.argsPrefix).toEqual(["--connection", "lando-root"]);
  expect(managedWin.managedSpawn).toBe("connection");
  expect(managedWin.runtimeDir).toBeUndefined();
  expect(managedWin.env).toBeUndefined();
  expect(managedWin.argsPrefix).toEqual(["--connection", "lando-root"]);
  expect(managedWin.cmd.endsWith("podman.exe")).toBe(true);
});
