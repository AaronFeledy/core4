import { describe, expect, test } from "bun:test";
import { makeTestPrivilegeService } from "@lando/sdk/test";
import { Effect } from "effect";
import {
  applyApprovedPrerequisitePlan,
  inspectPrerequisiteSetupPlan,
  parseLinuxHostRelease,
} from "../src/prerequisite-provision.ts";
import type { UserManagerHost } from "../src/user-manager.ts";

const probes = (hasUidmapTools: boolean) => ({
  probe: () => ({
    subidConfigured: true,
    subidRangeSufficient: true,
    subidRangesDisjoint: true,
    hasUidmapTools,
    cgroupsV2Delegated: true,
    hasXdgRuntimeDir: true,
  }),
});

describe("uidmap provider setup", () => {
  test("plans the fixed uidmap change only for exact Ubuntu 26.04", () => {
    // Given
    const host = parseLinuxHostRelease('ID=ubuntu\nVERSION_ID="26.04"\n');

    // When
    const plan = Effect.runSync(
      inspectPrerequisiteSetupPlan({ platform: "linux", host, probes: probes(false), user: "testuser" }),
    );

    // Then
    expect(plan.changes).toEqual([
      expect.objectContaining({
        _tag: "install-uidmap",
        platform: "linux",
        distribution: "ubuntu",
        version: "26.04",
      }),
    ]);
  });

  test("plans the Linux-family uidmap change for WSL identity", () => {
    // Given: WSL running the supported Ubuntu release without uidmap tools.
    const host = parseLinuxHostRelease('ID=ubuntu\nVERSION_ID="26.04"\n');

    // When: provider setup inspects rootless prerequisites.
    const plan = Effect.runSync(
      inspectPrerequisiteSetupPlan({ platform: "wsl", host, probes: probes(false), user: "testuser" }),
    );

    // Then: WSL receives the same Linux-family provisioning change.
    expect(plan.changes).toEqual([expect.objectContaining({ _tag: "install-uidmap", platform: "linux" })]);
  });

  test("fails closed on another host without emitting a change", () => {
    // Given
    const host = parseLinuxHostRelease('ID=fedora\nVERSION_ID="42"\n');

    // When
    const exit = Effect.runSyncExit(
      inspectPrerequisiteSetupPlan({ platform: "linux", host, probes: probes(false), user: "testuser" }),
    );

    // Then
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("ProviderSetupUnsupportedHostError");
    }
  });

  test("applies only fixed apt-get argv and re-probes", async () => {
    // Given
    let installed = false;
    const commands: ReadonlyArray<string>[] = [];
    const privilege = makeTestPrivilegeService({
      elevate: (command: ReadonlyArray<string>) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.includes("install")) installed = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    });
    const plan = Effect.runSync(
      inspectPrerequisiteSetupPlan({
        platform: "linux",
        host: { id: "ubuntu", versionId: "26.04" },
        probes: { ...probes(false), probe: () => ({ ...probes(false).probe(), hasUidmapTools: installed }) },
        user: "testuser",
      }),
    );

    // When
    await Effect.runPromise(
      applyApprovedPrerequisitePlan(plan, {
        privilege,
        probes: { ...probes(false), probe: () => ({ ...probes(false).probe(), hasUidmapTools: installed }) },
        user: "testuser",
      }),
    );

    // Then
    expect(commands).toEqual([
      ["/usr/bin/apt-get", "update"],
      ["/usr/bin/apt-get", "install", "--yes", "--no-install-recommends", "uidmap"],
    ]);
  });
});

describe("subordinate ID account", () => {
  test("plans and applies subid maps for the passwd account when $USER differs", async () => {
    const envUser = "env-user";
    const accountUser = "passwd-account";
    const previousUser = process.env.USER;
    process.env.USER = envUser;
    const userManager: UserManagerHost = {
      account: () => ({ uid: 1001, user: accountUser }),
      managerRunning: () => true,
      showUnit: () => Effect.succeed({ _tag: "unknown", reason: "test" }),
      pathExists: () => false,
    };
    const missingSubid = {
      probe: () => ({
        subidConfigured: false,
        subidRangeSufficient: false,
        subidRangesDisjoint: true,
        hasUidmapTools: true,
        cgroupsV2Delegated: true,
        hasXdgRuntimeDir: true,
      }),
    };

    try {
      const plan = Effect.runSync(
        inspectPrerequisiteSetupPlan({
          platform: "linux",
          host: { id: "ubuntu", versionId: "26.04" },
          probes: missingSubid,
          user: envUser,
          hasSystemd: true,
          userManager,
        }),
      );

      expect(
        plan.changes.filter(
          (change) => change._tag === "provision-subuid" || change._tag === "provision-subgid",
        ),
      ).toEqual([
        expect.objectContaining({ _tag: "provision-subuid", user: accountUser }),
        expect.objectContaining({ _tag: "provision-subgid", user: accountUser }),
      ]);

      const commands: ReadonlyArray<string>[] = [];
      await Effect.runPromise(
        applyApprovedPrerequisitePlan(plan, {
          probes: missingSubid,
          privilege: makeTestPrivilegeService({
            elevate: (command: ReadonlyArray<string>) =>
              Effect.sync(() => {
                commands.push(command);
                return { exitCode: 0, stdout: "", stderr: "" };
              }),
          }),
          user: envUser,
          userManager,
        }),
      );

      expect(commands).toEqual([
        ["/usr/sbin/usermod", "--add-subuids", expect.stringMatching(/^\d+-\d+$/u), accountUser],
        ["/usr/sbin/usermod", "--add-subgids", expect.stringMatching(/^\d+-\d+$/u), accountUser],
      ]);
    } finally {
      if (previousUser === undefined) {
        delete process.env.USER;
      } else {
        process.env.USER = previousUser;
      }
    }
  });
});
