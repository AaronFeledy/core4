import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import type { HostMaintenanceContribution } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

import { makeLandoPaths } from "@lando/paths";
import { makeTestStateStore } from "@lando/state-store/testing";
import {
  HostMaintenanceRegistry,
  makeHostMaintenanceRegistryLayer,
  teardownHostMaintainers,
} from "../../src/runtime/host-maintenance.ts";

const paths = {
  ...makeLandoPaths({ userDataRoot: "/r" }),
  runtimeBinDir: "/r/bin",
  runtimeRunDir: "/r/run",
  runtimeStorageDir: "/r/storage",
  runtimeConfigDir: "/r/config",
  providerSocketPath: "/r/run/podman.sock",
  providerPidPath: "/r/run/podman.pid",
};
const storage = {
  stateStore: makeTestStateStore().service,
  privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
};

describe("teardownHostMaintainers", () => {
  test("each maintainer receives its contributing plugin's state subtree", async () => {
    const opened: string[] = [];
    const modules = ["@lando/a", "@lando/b"].map((name) => ({
      name,
      manifest: Schema.decodeUnknownSync(PluginManifest)({ name, version: "1.0.0", api: 4 }),
      hostMaintainers: [
        {
          id: `${name}-runtime`,
          teardown: (input: Parameters<NonNullable<HostMaintenanceContribution["teardown"]>>[0]) =>
            input.stateStore.open({ key: "receipt.json", version: 1, schema: Schema.String }).pipe(
              Effect.orDie,
              Effect.map((bucket) => {
                opened.push(bucket.path);
                return { terminated: false };
              }),
            ),
        },
      ],
    }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* HostMaintenanceRegistry;
        yield* teardownHostMaintainers(registry, { paths, platform: "linux", ...storage });
      }).pipe(Effect.provide(makeHostMaintenanceRegistryLayer(modules))),
    );
    expect(opened).toEqual(["/r/plugins/@lando/a/receipt.json", "/r/plugins/@lando/b/receipt.json"]);
  });
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
      teardownHostMaintainers(
        { maintainers: maintainers.map((maintainer) => ({ ...maintainer, pluginId: "@lando/test" })) },
        { paths, platform: "linux", ...storage },
      ),
    );
    expect(calls).toEqual([paths.providerPidPath]);
    expect(result).toEqual({ terminated: true, pid: 42 });
  });

  test("returns terminated false when every maintainer omits teardown", async () => {
    const result = await Effect.runPromise(
      teardownHostMaintainers(
        {
          maintainers: [
            { id: "a", pluginId: "@lando/a" },
            { id: "b", pluginId: "@lando/b" },
          ],
        },
        { paths, platform: "linux", ...storage },
      ),
    );
    expect(result).toEqual({ terminated: false });
  });
});
