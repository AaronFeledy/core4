import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit } from "effect";

import { ProviderSetupProvisioningError, ProviderSetupUnsupportedHostError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";

import {
  applyApprovedPrerequisitePlan,
  inspectPrerequisiteSetupPlan,
} from "../src/prerequisite-provision.ts";
import { CGROUPS_V2_DELEGATION_NO_SYSTEMD_REMEDIATION } from "../src/rootless-preflight.ts";

const probes = (cgroupsV2Delegated: boolean) => ({
  probe: () => ({
    subidConfigured: true,
    subidRangeSufficient: true,
    subidRangesDisjoint: true,
    hasUidmapTools: true,
    cgroupsV2Delegated,
    hasXdgRuntimeDir: true,
  }),
});

const debianHost = { id: "debian", versionId: "13" };

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected Effect failure");
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag !== "Some") {
    throw new Error("expected tagged failure");
  }
  return failure.value;
};

describe("cgroups delegation setup", () => {
  test("fails closed on a tini/no-systemd host without planning a drop-in", () => {
    const exit = Effect.runSyncExit(
      inspectPrerequisiteSetupPlan({
        platform: "linux",
        host: debianHost,
        probes: probes(false),
        user: "testuser",
        hasSystemd: false,
      }),
    );

    const error = failureOf(exit);
    expect(error).toBeInstanceOf(ProviderSetupUnsupportedHostError);
    if (!(error instanceof ProviderSetupUnsupportedHostError)) return;
    expect(error.prerequisite).toBe("cgroups-delegation");
    expect(error.message).toMatch(/not running systemd/i);
    expect(error.remediation).toBe(CGROUPS_V2_DELEGATION_NO_SYSTEMD_REMEDIATION);
    expect(error.remediation).toContain("lando setup --provider=docker");
    expect(error.remediation).not.toContain("systemctl daemon-reload");
  });

  test("does not run systemctl when applying a leftover drop-in plan on a tini host", async () => {
    const commands: ReadonlyArray<string>[] = [];
    const privilege = {
      elevate: (command: ReadonlyArray<string>) =>
        Effect.sync(() => {
          commands.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    };

    const exit = await Effect.runPromiseExit(
      applyApprovedPrerequisitePlan(
        {
          providerId: ProviderId.make("lando"),
          changes: [
            {
              _tag: "provision-cgroups-delegation",
              path: "/etc/systemd/system/user@.service.d/delegate.conf",
              reason: "test",
            },
          ],
        },
        {
          privilege,
          probes: probes(false),
          user: "testuser",
          hasSystemd: false,
        },
      ),
    );

    expect(commands).toEqual([]);
    const error = failureOf(exit);
    expect(error).toBeInstanceOf(ProviderSetupProvisioningError);
    if (!(error instanceof ProviderSetupProvisioningError)) return;
    expect(error.change).toBe("provision-cgroups-delegation");
    expect(error.remediation).toBe(CGROUPS_V2_DELEGATION_NO_SYSTEMD_REMEDIATION);
    expect(error.remediation).toContain("lando setup --provider=docker");
    expect(error.remediation).not.toContain("systemctl daemon-reload");
  });
});
