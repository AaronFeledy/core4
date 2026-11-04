import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { HostMaintenanceContribution } from "@lando/sdk/plugins";

import { teardownHostMaintainers } from "../../src/runtime/host-maintenance.ts";

const paths = {
  runtimeBinDir: "/r/bin",
  runtimeRunDir: "/r/run",
  runtimeStorageDir: "/r/storage",
  runtimeConfigDir: "/r/config",
  providerSocketPath: "/r/run/podman.sock",
  providerPidPath: "/r/run/podman.pid",
};

describe("teardownHostMaintainers", () => {
  test("skips maintainers without teardown and aggregates terminated results", async () => {
    const calls: string[] = [];
    const maintainers: HostMaintenanceContribution[] = [
      { id: "no-teardown" },
      {
        id: "with-teardown",
        teardown: (input) => {
          calls.push(input.paths.providerPidPath);
          return Effect.succeed({ terminated: true, pid: 42 });
        },
      },
    ];
    const result = await Effect.runPromise(
      teardownHostMaintainers({ maintainers }, { paths, platform: "linux" }),
    );
    expect(calls).toEqual([paths.providerPidPath]);
    expect(result).toEqual({ terminated: true, pid: 42 });
  });

  test("returns terminated false when every maintainer omits teardown", async () => {
    const result = await Effect.runPromise(
      teardownHostMaintainers({ maintainers: [{ id: "a" }, { id: "b" }] }, { paths, platform: "linux" }),
    );
    expect(result).toEqual({ terminated: false });
  });
});
