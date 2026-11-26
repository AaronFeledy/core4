import { describe, expect, test } from "bun:test";
import { makeHostChangeApplier } from "@lando/engine/host-changes/apply";
import { PrivilegeCredentialsRequiredError, ProviderSetupUnsupportedHostError } from "@lando/sdk/errors";
import type { HostChangeProposal, PrivilegeSession } from "@lando/sdk/services";
import { Cause, Duration, Effect, Exit } from "effect";
import { PREREQUISITE_CHANGES } from "../src/prerequisite-changes.ts";
import { type PrerequisiteInspection, planPrerequisiteHostChanges } from "../src/prerequisite-provision.ts";
import { CGROUPS_V2_DELEGATION_NO_SYSTEMD_REMEDIATION } from "../src/rootless-preflight.ts";
import { type UserManagerHost, type UserManagerUnit, parseUserManagerShow } from "../src/user-manager.ts";
import { DELEGATE_CONF_CONTENT, DELEGATE_CONF_DIR, DELEGATE_CONF_PATH } from "../src/user-manager-changes.ts";

type Probes = PrerequisiteInspection["probes"];

const probes = (overrides: Partial<ReturnType<Probes["probe"]>> = {}): Probes => ({
  probe: () => ({
    subidConfigured: true,
    subidRangeSufficient: true,
    subidRangesDisjoint: true,
    hasUidmapTools: true,
    cgroupsV2Delegated: true,
    hasXdgRuntimeDir: true,
    ...overrides,
  }),
});

const managerHost = (input: {
  readonly running: () => boolean;
  readonly unit?: UserManagerUnit;
  readonly dropInExists?: () => boolean;
}): UserManagerHost => ({
  account: () => ({ uid: 1001, user: "dev" }),
  managerRunning: input.running,
  showUnit: () => Effect.succeed(input.unit ?? { _tag: "unknown", reason: "test" }),
  pathExists: () => input.dropInExists?.() === true,
});

const lackingDelegation: UserManagerUnit = {
  _tag: "known",
  loadState: "loaded",
  delegateControllers: new Set(["pids"]),
};
const quickWait = { maxAttempts: 3, delay: Duration.millis(1) };

const plan = (input: Partial<PrerequisiteInspection>) =>
  Effect.runSync(
    planPrerequisiteHostChanges({
      platform: "linux",
      host: { id: "ubuntu", versionId: "26.04" },
      probes: probes(),
      user: "dev",
      hasSystemd: true,
      readHostFile: () => undefined,
      pathExists: () => false,
      managerWaitPolicy: quickWait,
      ...input,
    }),
  );

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findErrorOption(exit.cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

/** Apply one proposal through the engine's applier, recording each privileged argv and its input. */
const apply = async (
  proposal: HostChangeProposal,
  exitCodeFor: (argv: ReadonlyArray<string>) => number = () => 0,
  elevate?: PrivilegeSession["elevate"],
) => {
  const commands: string[] = [];
  const inputs: string[] = [];
  const session: PrivilegeSession = {
    transport: "direct",
    elevate:
      elevate ??
      ((argv, options) =>
        Effect.sync(() => {
          commands.push(argv.join(" "));
          if (options?.stdin !== undefined) inputs.push(new TextDecoder().decode(options.stdin));
          return { exitCode: exitCodeFor(argv), stdout: "", stderr: "" };
        })),
  };
  const run = makeHostChangeApplier({
    proposals: [proposal],
    approved: new Set([proposal.change.id]),
    session,
    redact: (text) => text,
  });
  const exit = await Effect.runPromiseExit(run.applier.apply(proposal.change.id));
  return { exit, commands, inputs };
};

const only = (proposals: ReadonlyArray<HostChangeProposal>): HostChangeProposal => {
  expect(proposals).toHaveLength(1);
  const [proposal] = proposals;
  if (proposal === undefined) throw new Error("expected one proposal");
  return proposal;
};

describe("parseUserManagerShow", () => {
  test("reads a stopped instance's configured delegation", () => {
    const unit = parseUserManagerShow("LoadState=loaded\nDelegateControllers=cpu memory pids\n");
    expect(unit).toEqual({
      _tag: "known",
      loadState: "loaded",
      delegateControllers: new Set(["cpu", "memory", "pids"]),
    });
  });

  test("treats missing fields as unknown rather than as lacking delegation", () => {
    expect(parseUserManagerShow("LoadState=loaded\n")._tag).toBe("unknown");
  });
});

describe("uidmap", () => {
  test("is planned with fixed apt-get commands on Ubuntu, Debian, and WSL", () => {
    for (const platform of ["linux", "wsl"] as const) {
      const proposal = only(plan({ platform, probes: probes({ hasUidmapTools: false }) }));
      expect(proposal.change.id).toBe(PREREQUISITE_CHANGES.uidmap);
      expect(proposal.change.steps.map((step) => step.argv.join(" "))).toEqual([
        "/usr/bin/apt-get update",
        "/usr/bin/apt-get install --yes --no-install-recommends uidmap",
      ]);
    }
  });

  test("fails closed on another distribution without planning a change", () => {
    const exit = Effect.runSyncExit(
      planPrerequisiteHostChanges({
        platform: "linux",
        host: { id: "fedora", versionId: "42" },
        probes: probes({ hasUidmapTools: false }),
        user: "dev",
      }),
    );
    expect(failureOf(exit)).toBeInstanceOf(ProviderSetupUnsupportedHostError);
  });

  test("applies the planned commands and re-probes, and runs nothing once installed", async () => {
    let installed = false;
    const proposal = only(
      plan({ probes: { probe: () => ({ ...probes().probe(), hasUidmapTools: installed }) } }),
    );

    const first = await apply(proposal, (argv) => {
      if (argv.includes("install")) installed = true;
      return 0;
    });
    const again = await apply(proposal);

    expect(first.commands).toEqual([
      "/usr/bin/apt-get update",
      "/usr/bin/apt-get install --yes --no-install-recommends uidmap",
    ]);
    expect(Exit.isSuccess(again.exit) ? again.exit.value.outcome : undefined).toBe("already-satisfied");
    expect(again.commands).toEqual([]);
  });

  test("a privilege failure keeps its own tag and remediation", async () => {
    const denied = new PrivilegeCredentialsRequiredError({
      purpose: "x",
      message: "needs a password",
      remediation: "Run `sudo -v`.",
    });
    const proposal = only(plan({ probes: probes({ hasUidmapTools: false }) }));

    const { exit } = await apply(proposal, undefined, () => Effect.fail(denied));

    expect(failureOf(exit)).toBe(denied);
  });
});

describe("subordinate ID ranges", () => {
  test("plans the passwd account's ranges above every existing range, with exact usermod commands", () => {
    const proposals = plan({
      probes: probes({ subidConfigured: false }),
      user: "env-user",
      userManager: managerHost({ running: () => true }),
      readHostFile: (path) => (path === "/etc/subuid" ? "other:100000:65536\n" : undefined),
    });

    expect(proposals.map(({ change }) => change.steps[0].argv)).toEqual([
      ["/usr/sbin/usermod", "--add-subuids", "165536-231071", "dev"],
      ["/usr/sbin/usermod", "--add-subgids", "100000-165535", "dev"],
    ]);
  });

  test("is satisfied when a range appeared, and stale when the planned range was taken", async () => {
    let subuid = "";
    const proposal = plan({ probes: probes({ subidConfigured: false }), readHostFile: () => subuid })[0];
    if (proposal === undefined) throw new Error("expected a subuid proposal");

    subuid = "dev:300000:65536\n";
    const satisfied = await apply(proposal);
    subuid = "other:100000:10\n";
    const stale = await apply(proposal);

    expect(Exit.isSuccess(satisfied.exit) ? satisfied.exit.value.outcome : undefined).toBe(
      "already-satisfied",
    );
    expect(failureOf(stale.exit)).toMatchObject({ _tag: "HostChangeStaleError" });
    expect([...satisfied.commands, ...stale.commands]).toEqual([]);
  });
});

describe("cgroups delegation and lingering", () => {
  test("a host without systemd fails closed without planning a drop-in", () => {
    const exit = Effect.runSyncExit(
      planPrerequisiteHostChanges({
        platform: "linux",
        host: { id: "debian", versionId: "13" },
        probes: probes({ cgroupsV2Delegated: false }),
        user: "dev",
        hasSystemd: false,
      }),
    );
    const error = failureOf(exit);
    expect(error).toBeInstanceOf(ProviderSetupUnsupportedHostError);
    expect(error instanceof ProviderSetupUnsupportedHostError ? error.remediation : "").toBe(
      CGROUPS_V2_DELEGATION_NO_SYSTEMD_REMEDIATION,
    );
  });

  test("with no user manager, plans lingering for separate approval and the drop-in only when delegation is confirmed missing", () => {
    const lacking = plan({ userManager: managerHost({ running: () => false, unit: lackingDelegation }) });
    const unknown = plan({ userManager: managerHost({ running: () => false }) });

    expect(lacking.map(({ change }) => change.id)).toEqual([
      PREREQUISITE_CHANGES.delegation,
      PREREQUISITE_CHANGES.linger,
    ]);
    expect(unknown.map(({ change }) => change.id)).toEqual([PREREQUISITE_CHANGES.linger]);
    expect(unknown[0]?.change).toMatchObject({
      consent: "separate",
      optInFlag: "enable-linger",
      persistent: true,
      requirement: "recommended",
    });
  });

  test("an existing drop-in the loaded unit does not apply fails closed instead of lingering", () => {
    const exit = Effect.runSyncExit(
      planPrerequisiteHostChanges({
        platform: "linux",
        host: undefined,
        probes: probes(),
        user: "dev",
        hasSystemd: true,
        userManager: managerHost({ running: () => false, unit: lackingDelegation, dropInExists: () => true }),
      }),
    );
    expect(failureOf(exit)).toMatchObject({
      _tag: "ProviderSetupUnsupportedHostError",
      prerequisite: "cgroups-delegation",
    });
  });

  test("plans nothing for a running, delegating manager", () => {
    expect(plan({ userManager: managerHost({ running: () => true }) })).toEqual([]);
  });

  test("writes the drop-in from piped input, then needs a new login only under a running manager", async () => {
    const running = only(
      plan({
        probes: probes({ cgroupsV2Delegated: false }),
        userManager: managerHost({ running: () => true }),
      }),
    );
    const later = plan({ userManager: managerHost({ running: () => false, unit: lackingDelegation }) })[0];
    if (later === undefined) throw new Error("expected a delegation proposal");

    const underRunning = await apply(running);
    const beforeStart = await apply(later);

    expect(underRunning.commands).toEqual([
      `/usr/bin/install -d -m 0755 ${DELEGATE_CONF_DIR}`,
      `/usr/bin/tee ${DELEGATE_CONF_PATH}`,
      `/usr/bin/chmod 0644 ${DELEGATE_CONF_PATH}`,
      "/usr/bin/systemctl daemon-reload",
    ]);
    expect(underRunning.inputs).toEqual([DELEGATE_CONF_CONTENT]);
    expect(failureOf(underRunning.exit)).toMatchObject({ _tag: "HostChangeFailedError" });
    expect(String(Reflect.get(Object(failureOf(underRunning.exit)), "remediation"))).toContain("Log out");
    expect(Exit.isSuccess(beforeStart.exit)).toBe(true);
  });

  test("no planned step opens its input by path, and the manual form is runnable", () => {
    const planned = plan({
      probes: probes({ cgroupsV2Delegated: false }),
      userManager: managerHost({ running: () => true }),
    });

    for (const { change } of planned) {
      for (const step of change.steps) expect(step.argv).not.toContain("/dev/stdin");
      if (change.steps.some((step) => step.stdin !== undefined)) {
        expect(change.manual).toContain(`sudo tee '${DELEGATE_CONF_PATH}'`);
        expect(change.manual).not.toContain("<");
      }
    }
  });

  test("a drop-in that appeared after planning is stale and is left alone", async () => {
    let exists = false;
    const proposal = only(
      plan({
        probes: probes({ cgroupsV2Delegated: false }),
        userManager: managerHost({ running: () => true }),
        pathExists: () => exists,
      }),
    );
    exists = true;

    const { exit, commands } = await apply(proposal);

    expect(failureOf(exit)).toMatchObject({ _tag: "HostChangeStaleError" });
    expect(commands).toEqual([]);
  });

  test("lingering waits for the manager and starts it only when it is still absent", async () => {
    const lingerFor = (running: () => boolean) => {
      const proposal = plan({ userManager: managerHost({ running }) })[0];
      if (proposal === undefined) throw new Error("expected a linger proposal");
      return proposal;
    };
    let checks = 0;
    const waited = await apply(lingerFor(() => ++checks > 2));
    let started = false;
    const startedAfter = await apply(
      lingerFor(() => started),
      (argv) => {
        if (argv.includes("start")) started = true;
        return 0;
      },
    );
    const never = await apply(lingerFor(() => false));

    expect(waited.commands).toEqual(["/usr/bin/loginctl enable-linger dev"]);
    expect(startedAfter.commands).toEqual([
      "/usr/bin/loginctl enable-linger dev",
      "/usr/bin/systemctl start --no-block user@1001.service",
    ]);
    expect(failureOf(never.exit)).toMatchObject({ _tag: "HostChangeFailedError" });
    expect(String(Reflect.get(Object(failureOf(never.exit)), "remediation"))).toContain(
      "loginctl enable-linger dev",
    );
  });
});
