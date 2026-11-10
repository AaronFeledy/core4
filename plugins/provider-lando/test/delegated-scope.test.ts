import { describe, expect, test } from "bun:test";

import {
  type DelegatedScopeHost,
  delegatedLaunchEligibility,
  delegatedScopeRemediation,
  observeServicePlacement,
} from "../src/delegated-scope.ts";

const userService = "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service";
const scope = `${userService}/app.slice/run-p42-i1.scope`;

interface FakeHost {
  readonly executables?: ReadonlyArray<string>;
  readonly files?: Readonly<Record<string, string>>;
  readonly owners?: Readonly<Record<string, number>>;
  readonly uid?: number | undefined;
}

const eligibleFiles: Readonly<Record<string, string>> = {
  "/run/user/1000/systemd/private": "",
  "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids",
  [`${userService}/cgroup.controllers`]: "cpu memory pids",
};

const without = (path: string): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(eligibleFiles).filter(([candidate]) => candidate !== path));

const fakeHost = (input: FakeHost = {}): DelegatedScopeHost => {
  const files = input.files ?? eligibleFiles;
  return {
    uid: () => ("uid" in input ? input.uid : 1000),
    isExecutable: (path) => (input.executables ?? ["/usr/bin/systemd-run", "/usr/bin/env"]).includes(path),
    exists: (path) => path in files,
    readText: (path) => files[path],
    ownerUid: (path) => input.owners?.[path],
  };
};

describe("delegatedLaunchEligibility", () => {
  test("selects the absolute host systemd-run and the user's real runtime dir", () => {
    expect(delegatedLaunchEligibility("linux", fakeHost())).toEqual({
      eligible: true,
      systemdRun: "/usr/bin/systemd-run",
      userRuntimeDir: "/run/user/1000",
    });
    expect(
      delegatedLaunchEligibility("wsl", fakeHost({ executables: ["/bin/systemd-run", "/usr/bin/env"] })),
    ).toMatchObject({ eligible: true, systemdRun: "/bin/systemd-run" });
  });

  test.each([
    ["darwin", fakeHost(), "unsupported-platform"],
    ["win32", fakeHost(), "unsupported-platform"],
    ["linux", fakeHost({ executables: ["/usr/bin/env"] }), "missing-launcher"],
    ["linux", fakeHost({ executables: ["/usr/bin/systemd-run"] }), "missing-launcher"],
    ["linux", fakeHost({ uid: undefined }), "no-user-manager"],
    ["linux", fakeHost({ files: without("/run/user/1000/systemd/private") }), "no-user-manager"],
    ["linux", fakeHost({ files: without("/sys/fs/cgroup/cgroup.controllers") }), "cgroup-v1"],
    [
      "linux",
      fakeHost({ files: { ...eligibleFiles, [`${userService}/cgroup.controllers`]: "memory pids" } }),
      "missing-controllers",
    ],
  ] as const)("%s host is ineligible: %s", (platform, host, reason) => {
    expect(delegatedLaunchEligibility(platform, host)).toEqual({ eligible: false, reason });
  });
});

describe("observeServicePlacement", () => {
  const placed = (cgroup: string, controllers: string, owner: number) =>
    fakeHost({
      files: {
        "/proc/42/cgroup": `0::${cgroup}\n`,
        [`/sys/fs/cgroup${cgroup}/cgroup.controllers`]: controllers,
      },
      owners: { [`/sys/fs/cgroup${cgroup}`]: owner },
    });
  const scopePath = scope.slice("/sys/fs/cgroup".length);

  test("a user-owned scope with memory, pids and cpu is delegated", () => {
    expect(observeServicePlacement(42, placed(scopePath, "cpu memory pids", 1000))).toBe("delegated");
  });

  test.each([
    ["the WSL init scope owned by root", placed("/init.scope", "cpu memory pids", 0)],
    ["a user-owned cgroup without the pids controller", placed(scopePath, "cpu memory", 1000)],
    ["the root cgroup", placed("/", "cpu memory pids", 1000)],
    ["a process with no readable cgroup", fakeHost({ files: {} })],
  ])("%s is shared", (_name, host) => {
    expect(observeServicePlacement(42, host)).toBe("shared");
  });
});

test("ineligibility remediation names the step, never a manual Podman launch", () => {
  expect(delegatedScopeRemediation("no-user-manager")).toContain("loginctl enable-linger $USER");
  expect(delegatedScopeRemediation("missing-controllers")).toContain("Delegate=cpu cpuset io memory pids");
});
