import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  applyApprovedProviderSetupPlan,
  inspectUidmapSetupPlan,
  parseLinuxHostRelease,
} from "../src/uidmap-provision.ts";

const probes = (hasUidmapTools: boolean) => ({
  probe: () => ({
    subidConfigured: true,
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
    const plan = Effect.runSync(inspectUidmapSetupPlan({ platform: "linux", host, probes: probes(false) }));

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

  test("fails closed on another host without emitting a change", () => {
    // Given
    const host = parseLinuxHostRelease('ID=fedora\nVERSION_ID="42"\n');

    // When
    const exit = Effect.runSyncExit(
      inspectUidmapSetupPlan({ platform: "linux", host, probes: probes(false) }),
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
    const privilege = {
      elevate: (command: ReadonlyArray<string>) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.includes("install")) installed = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    };
    const plan = Effect.runSync(
      inspectUidmapSetupPlan({
        platform: "linux",
        host: { id: "ubuntu", versionId: "26.04" },
        probes: { ...probes(false), probe: () => ({ ...probes(false).probe(), hasUidmapTools: installed }) },
      }),
    );

    // When
    await Effect.runPromise(
      applyApprovedProviderSetupPlan(plan, {
        privilege,
        probes: { ...probes(false), probe: () => ({ ...probes(false).probe(), hasUidmapTools: installed }) },
      }),
    );

    // Then
    expect(commands).toEqual([
      ["/usr/bin/apt-get", "update"],
      ["/usr/bin/apt-get", "install", "--yes", "--no-install-recommends", "uidmap"],
    ]);
  });
});
