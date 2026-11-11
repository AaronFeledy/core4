import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginDoctorCheckInput } from "@lando/sdk/plugins";
import { Effect } from "effect";

import type { DelegatedScopeHost } from "../src/delegated-scope.ts";
import { makeManagedRuntimeCgroupCheck } from "../src/managed-runtime-cgroup-check.ts";

const userService = "/user.slice/user-1000.slice/user@1000.service";
const scope = `${userService}/app.slice/run-p4321-i1.scope`;

interface HostInput {
  readonly eligible: boolean;
  readonly servicePath?: string;
  readonly containers?: Readonly<Record<number, string>>;
}

const host = (input: HostInput): DelegatedScopeHost => {
  const files: Record<string, string> = {
    "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids",
    [`/sys/fs/cgroup${userService}/cgroup.controllers`]: "cpu memory pids",
    ...(input.eligible ? { "/run/user/1000/systemd/private": "" } : {}),
    ...(input.servicePath === undefined
      ? {}
      : {
          "/proc/4321/cgroup": `0::${input.servicePath}\n`,
          [`/sys/fs/cgroup${input.servicePath}/cgroup.controllers`]: "cpu memory pids",
        }),
    ...Object.fromEntries(
      Object.entries(input.containers ?? {}).map(([pid, path]) => [`/proc/${pid}/cgroup`, `0::${path}\n`]),
    ),
  };
  return {
    uid: () => 1000,
    isExecutable: (path) => ["/usr/bin/systemd-run", "/usr/bin/env"].includes(path),
    exists: (path) => path in files,
    readText: (path) => files[path],
    ownerUid: (path) => (path.startsWith(`/sys/fs/cgroup${userService}`) ? 1000 : 0),
  };
};

const runCheck = async (input: HostInput & { readonly running: boolean }) => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "lando-cgroup-doctor-"));
  try {
    if (input.running) {
      const runDir = join(userDataRoot, "runtime", "run");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "podman.pid"), "4321");
      await writeFile(join(runDir, "podman.pid.launch.json"), JSON.stringify({ pid: 4321, env: {} }));
    }
    const check = makeManagedRuntimeCgroupCheck({
      host: host(input),
      runningContainerPids: () => Effect.succeed(Object.keys(input.containers ?? {}).map(Number)),
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

describe("managed runtime container cgroup doctor check", () => {
  test("an idle runtime on an eligible host passes with what the next launch does", async () => {
    expect(await runCheck({ running: false, eligible: true })).toMatchObject([
      { status: "pass", runtime: { running: false }, context: { nextLaunch: "delegated" } },
    ]);
  });

  test("an idle runtime without a user manager warns with the step to get one", async () => {
    const [finding] = await runCheck({ running: false, eligible: false });
    expect(finding).toMatchObject({
      status: "warn",
      context: { nextLaunch: "shared", reason: "no-user-manager" },
    });
    expect(finding?.solutions[0]?.description).toContain("loginctl enable-linger");
  });

  test("a running service in an undelegated cgroup warns and asks for a poweroff when delegation is possible", async () => {
    const [finding] = await runCheck({ running: true, eligible: true, servicePath: "/init.scope" });
    expect(finding).toMatchObject({
      status: "warn",
      runtime: { running: true },
      context: { servicePlacement: "shared", serviceCgroup: "/init.scope" },
    });
    expect(finding?.solutions[0]?.description).toContain("lando poweroff");
  });

  test("a delegated service whose containers have their own cgroups passes", async () => {
    expect(
      await runCheck({
        running: true,
        eligible: true,
        servicePath: scope,
        containers: { 5001: `${scope}/libpod-abc` },
      }),
    ).toMatchObject([{ status: "pass", context: { servicePlacement: "delegated" } }]);
  });

  test("a delegated service still running containers created before delegation reports them apart", async () => {
    const [finding] = await runCheck({
      running: true,
      eligible: true,
      servicePath: scope,
      containers: { 5001: scope, 5002: `${scope}/libpod-abc` },
    });
    expect(finding).toMatchObject({
      status: "warn",
      context: { servicePlacement: "delegated", containersWithoutCgroup: "1" },
    });
    expect(finding?.solutions[0]?.description).toContain("lando rebuild");
  });

  test.each([
    ["darwin", "lando"],
    ["linux", "docker"],
  ] as const)("is silent on %s with provider %s", async (platform, providerId) => {
    const check = makeManagedRuntimeCgroupCheck({ host: host({ eligible: true }) });
    const findings = await Effect.runPromise(
      check.run({
        providerId,
        platform,
        env: {},
        userDataRoot: "/tmp/x",
        binDir: undefined,
        stateDir: undefined,
      }),
    );
    expect(findings).toEqual([]);
  });
});
