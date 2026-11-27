import { describe, expect, test } from "bun:test";
import { PrivilegeCredentialsRequiredError, ProviderSetupPrivilegeUnavailableError } from "@lando/sdk/errors";
import { ProviderId, type ProviderSetupPlan } from "@lando/sdk/schema";
import { makeTestPrivilegeService } from "@lando/sdk/test";
import { Cause, Duration, Effect, Exit } from "effect";
import {
  applyApprovedPrerequisitePlan,
  inspectPrerequisiteSetupPlan,
} from "../src/prerequisite-provision.ts";
import { type UserManagerHost, type UserManagerUnit, parseUserManagerShow } from "../src/user-manager.ts";

const readyProbes = {
  probe: () => ({
    subidConfigured: true,
    subidRangeSufficient: true,
    subidRangesDisjoint: true,
    hasUidmapTools: true,
    cgroupsV2Delegated: true,
    hasXdgRuntimeDir: true,
  }),
};

const managerHost = (input: {
  readonly running: () => boolean;
  readonly unit?: UserManagerUnit;
  readonly dropInExists?: boolean;
}): UserManagerHost => ({
  account: () => ({ uid: 1001, user: "dev" }),
  managerRunning: input.running,
  showUnit: () => Effect.succeed(input.unit ?? { _tag: "unknown", reason: "test" }),
  pathExists: () => input.dropInExists === true,
});

const delegating: UserManagerUnit = {
  _tag: "known",
  loadState: "loaded",
  delegateControllers: new Set(["cpu", "memory", "pids"]),
};

const plan = (lingerOnly = true): ProviderSetupPlan => ({
  providerId: ProviderId.make("lando"),
  changes: [
    ...(lingerOnly
      ? []
      : [
          {
            _tag: "provision-cgroups-delegation" as const,
            path: "/etc/systemd/system/user@.service.d/delegate.conf",
            reason: "test",
          },
        ]),
    { _tag: "enable-user-linger", user: "dev", uid: 1001, optedIn: false, reason: "test" },
  ],
});

const recordingPrivilege = (exitCodeFor: (command: ReadonlyArray<string>) => number = () => 0) => {
  const commands: string[] = [];
  return {
    commands,
    service: makeTestPrivilegeService({
      elevate: (command: ReadonlyArray<string>) =>
        Effect.sync(() => {
          commands.push(command.join(" "));
          return { exitCode: exitCodeFor(command), stdout: "", stderr: "" };
        }),
    }),
  };
};

const quickWait = { maxAttempts: 3, delay: Duration.millis(1) };

describe("parseUserManagerShow", () => {
  test("reads a stopped instance's configured delegation", () => {
    expect(parseUserManagerShow("LoadState=loaded\nDelegateControllers=cpu memory pids\n")).toEqual(
      delegating,
    );
  });

  test("treats missing fields as unknown rather than as lacking delegation", () => {
    expect(parseUserManagerShow("")._tag).toBe("unknown");
    expect(parseUserManagerShow("LoadState=loaded\n")._tag).toBe("unknown");
  });
});

describe("planning lingering", () => {
  test("plans lingering, with the user's opt-in, when no user manager runs", async () => {
    const result = await Effect.runPromise(
      inspectPrerequisiteSetupPlan({
        platform: "linux",
        host: { id: "ubuntu", versionId: "26.04" },
        probes: readyProbes,
        user: "ignored-env-user",
        hasSystemd: true,
        userManager: managerHost({ running: () => false, unit: delegating }),
        lingerOptIn: true,
      }),
    );

    expect(result.changes).toEqual([
      expect.objectContaining({ _tag: "enable-user-linger", user: "dev", uid: 1001, optedIn: true }),
    ]);
  });

  test("plans the drop-in only when the unit is confirmed to lack delegation", async () => {
    const inspect = (unit: UserManagerUnit) =>
      Effect.runPromise(
        inspectPrerequisiteSetupPlan({
          platform: "linux",
          host: undefined,
          probes: readyProbes,
          user: "dev",
          hasSystemd: true,
          userManager: managerHost({ running: () => false, unit }),
        }),
      );

    const lacking = await inspect({
      _tag: "known",
      loadState: "loaded",
      delegateControllers: new Set(["pids"]),
    });
    const unknown = await inspect({ _tag: "unknown", reason: "systemctl exited 1" });

    expect(lacking.changes.map((change) => change._tag)).toEqual([
      "provision-cgroups-delegation",
      "enable-user-linger",
    ]);
    expect(unknown.changes.map((change) => change._tag)).toEqual(["enable-user-linger"]);
  });

  test("an existing drop-in the loaded unit does not apply fails closed instead of lingering", async () => {
    const exit = await Effect.runPromiseExit(
      inspectPrerequisiteSetupPlan({
        platform: "linux",
        host: undefined,
        probes: readyProbes,
        user: "dev",
        hasSystemd: true,
        userManager: managerHost({
          running: () => false,
          unit: { _tag: "known", loadState: "loaded", delegateControllers: new Set(["pids"]) },
          dropInExists: true,
        }),
      }),
    );

    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
    expect(failure?._tag === "Some" ? failure.value : undefined).toMatchObject({
      _tag: "ProviderSetupUnsupportedHostError",
      prerequisite: "cgroups-delegation",
    });
  });

  test("plans nothing for a running manager", async () => {
    const result = await Effect.runPromise(
      inspectPrerequisiteSetupPlan({
        platform: "linux",
        host: undefined,
        probes: readyProbes,
        user: "dev",
        hasSystemd: true,
        userManager: managerHost({ running: () => true }),
      }),
    );

    expect(result.changes).toEqual([]);
  });
});

describe("applying lingering", () => {
  test("enables lingering and waits for the manager without starting or restarting it", async () => {
    let checks = 0;
    const privilege = recordingPrivilege();

    await Effect.runPromise(
      applyApprovedPrerequisitePlan(plan(), {
        probes: readyProbes,
        privilege: privilege.service,
        user: "dev",
        hasSystemd: true,
        userManager: managerHost({ running: () => ++checks > 1 }),
        managerWaitPolicy: quickWait,
      }),
    );

    expect(privilege.commands).toEqual(["/usr/bin/loginctl enable-linger dev"]);
  });

  test("starts the manager only when it is still not running after lingering", async () => {
    let started = false;
    const privilege = recordingPrivilege((command) => {
      if (command.includes("start")) started = true;
      return 0;
    });

    await Effect.runPromise(
      applyApprovedPrerequisitePlan(plan(), {
        probes: readyProbes,
        privilege: privilege.service,
        user: "dev",
        hasSystemd: true,
        userManager: managerHost({ running: () => started }),
        managerWaitPolicy: quickWait,
      }),
    );

    expect(privilege.commands).toEqual([
      "/usr/bin/loginctl enable-linger dev",
      "/usr/bin/systemctl start --no-block user@1001.service",
    ]);
  });

  test("a delegation drop-in before lingering needs no new login", async () => {
    const privilege = recordingPrivilege();

    await Effect.runPromise(
      applyApprovedPrerequisitePlan(plan(false), {
        probes: readyProbes,
        privilege: privilege.service,
        user: "dev",
        hasSystemd: true,
        userManager: managerHost({
          running: () => privilege.commands.some((c) => c.includes("enable-linger")),
        }),
        managerWaitPolicy: quickWait,
      }),
    );

    expect(privilege.commands.at(-1)).toBe("/usr/bin/loginctl enable-linger dev");
  });

  test("fails with a verify error when the manager never appears", async () => {
    const privilege = recordingPrivilege();

    const exit = await Effect.runPromiseExit(
      applyApprovedPrerequisitePlan(plan(), {
        probes: readyProbes,
        privilege: privilege.service,
        user: "dev",
        hasSystemd: true,
        userManager: managerHost({ running: () => false }),
        managerWaitPolicy: quickWait,
      }),
    );

    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
    const error = failure?._tag === "Some" ? failure.value : undefined;
    expect(error?._tag).toBe("ProviderSetupProvisioningError");
    expect(error?.remediation).toContain("loginctl enable-linger dev");
  });

  test("a privilege failure keeps its remediation under the provider's tag", async () => {
    const denied = new PrivilegeCredentialsRequiredError({
      purpose: "enable lingering",
      message: "needs a password",
      remediation: "Run `sudo -v`, or set `SUDO_ASKPASS`.",
    });

    const exit = await Effect.runPromiseExit(
      applyApprovedPrerequisitePlan(plan(), {
        probes: readyProbes,
        privilege: makeTestPrivilegeService({ elevate: () => Effect.fail(denied) }),
        user: "dev",
        hasSystemd: true,
      }),
    );

    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
    const error = failure?._tag === "Some" ? failure.value : undefined;
    expect(error).toBeInstanceOf(ProviderSetupPrivilegeUnavailableError);
    expect(error?.remediation).toBe(denied.remediation);
  });
});
