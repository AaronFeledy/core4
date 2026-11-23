import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  managedHealthRunKey,
  managedHealthUnitName,
  managedHealthUnitPrefix,
} from "@lando/container-runtime/podman/managed-health-units";
import type { PluginDoctorCheckInput } from "@lando/sdk/plugins";
import { Effect } from "effect";

import type { DelegatedScopeHost } from "../src/delegated-scope.ts";
import { makeManagedRuntimeNativeHealthCheck } from "../src/managed-runtime-native-health-check.ts";
import type { HealthRun } from "../src/native-health-plan.ts";

const userService = "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service";
const privateDir = "/run/user/1000/lando-0123456789abcdef";
const prefix = managedHealthUnitPrefix(privateDir);
const healthRun = (id: string): HealthRun => ({
  containerId: id,
  key: managedHealthRunKey(id, "2026-11-23T00:00:00Z"),
  startedAtMs: 0,
  intervalMs: 30_000,
  startPeriodMs: 0,
  timeoutSeconds: 5,
});

interface CheckInput {
  readonly running?: "delegated" | "shared";
  readonly systemctl?: boolean;
  readonly userManager?: boolean;
  /** False when the pid file names a process that has exited. */
  readonly alive?: boolean;
  readonly runs?: ReadonlyArray<HealthRun> | "unreadable";
  readonly timers?: ReadonlyArray<HealthRun>;
  readonly privateDir?: "unresolved";
}

const host = (input: CheckInput): DelegatedScopeHost => {
  const files: Record<string, string> = {
    "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids",
    [`${userService}/cgroup.controllers`]: "cpu memory pids",
    ...(input.userManager === false ? {} : { "/run/user/1000/systemd/private": "" }),
    ...(input.running === undefined || input.alive === false
      ? {}
      : {
          "/proc/4321/cgroup": `0::${userService.slice("/sys/fs/cgroup".length)}/app.slice/run-p4321-i1.scope\n`,
        }),
  };
  const tools = [
    "/usr/bin/systemd-run",
    "/usr/bin/env",
    ...(input.systemctl === false ? [] : ["/usr/bin/systemctl"]),
  ];
  return {
    uid: () => 1000,
    isExecutable: (path) => tools.includes(path),
    exists: (path) => path in files,
    readText: (path) => files[path],
    ownerUid: () => 1000,
  };
};

const runCheck = async (input: CheckInput) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "lando-native-health-doctor-"));
  try {
    if (input.running !== undefined) {
      const runDir = join(userDataRoot, "runtime", "run");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "podman.pid"), "4321");
      await writeFile(
        join(runDir, "podman.pid.launch.json"),
        JSON.stringify({ pid: 4321, env: {}, containerCgroups: input.running }),
      );
    }
    const check = makeManagedRuntimeNativeHealthCheck({
      host: host(input),
      healthRuns: () => Effect.succeed(input.runs === "unreadable" ? undefined : (input.runs ?? [])),
      transientUnits: () =>
        (input.timers ?? []).map((run) => `${managedHealthUnitName(prefix, run.key, "main")}.timer`),
      privateRuntimeDir: () => Effect.succeed(input.privateDir === "unresolved" ? undefined : privateDir),
    });
    const checkInput: PluginDoctorCheckInput = {
      providerId: "lando",
      platform: "linux",
      env: {},
      userDataRoot,
      binDir: undefined,
      stateDir: undefined,
    };
    return await Effect.runPromise(check.run(checkInput));
  } finally {
    await rm(userDataRoot, { recursive: true, force: true });
  }
};

describe("managed runtime native health doctor check", () => {
  test("an idle runtime on an eligible host passes", async () => {
    expect(await runCheck({})).toMatchObject([{ status: "pass", context: { scheduler: "lando" } }]);
  });

  test.each([
    ["missing-tools", { systemctl: false }, "install systemd"],
    ["no-user-manager", { userManager: false }, "loginctl enable-linger"],
  ] as const)("warns with the fix when the user manager is unreachable (%s)", async (reason, input, fix) => {
    const [finding] = await runCheck({ ...input, running: "delegated" });
    expect(finding).toMatchObject({ status: "warn", context: { scheduler: "none", reason } });
    expect(finding?.solutions[0]?.description).toContain(fix);
  });

  test("a pid file whose process has exited is judged by what the next launch does", async () => {
    expect(await runCheck({ running: "shared", alive: false })).toMatchObject([
      { status: "pass", runtime: { running: false }, context: { nextLaunch: "delegated" } },
    ]);
  });

  test.each([
    ["unreadable containers", { runs: "unreadable" }, { containers: "unreadable" }],
    ["an unresolved private runtime dir", { privateDir: "unresolved" }, { privateRuntimeDir: "unresolved" }],
  ] as const)("warns instead of passing with %s", async (_name, input, context) => {
    expect(await runCheck({ running: "delegated", ...input })).toMatchObject([{ status: "warn", context }]);
  });

  test("a service running without a delegated scope warns and asks for a poweroff", async () => {
    const [finding] = await runCheck({ running: "shared" });
    expect(finding).toMatchObject({ status: "warn", context: { servicePlacement: "shared" } });
    expect(finding?.solutions[0]?.description).toContain("lando poweroff");
  });

  test("passes when every owned healthchecked container has its main timer", async () => {
    const runs = [healthRun("a".repeat(64)), healthRun("b".repeat(64))];
    expect(await runCheck({ running: "delegated", runs, timers: runs })).toMatchObject([
      { status: "pass", context: { scheduler: "lando", healthchecked: "2" } },
    ]);
  });

  test("warns with the count of containers missing a timer", async () => {
    const runs = [healthRun("a".repeat(64)), healthRun("b".repeat(64))];
    const [finding] = await runCheck({ running: "delegated", runs, timers: runs.slice(0, 1) });
    expect(finding).toMatchObject({ status: "warn", context: { withoutTimer: "1" } });
    expect(finding?.severity).toBe("warn");
  });
});
