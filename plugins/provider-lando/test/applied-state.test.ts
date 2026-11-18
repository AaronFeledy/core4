import { describe, expect, test } from "bun:test";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, AppId, type AppPlan, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { APPLIED_STATE_VERSION, inspectAppliedPlan } from "../src/applied-state.ts";

describe("provider-lando applied plan inspection versioning", () => {
  test("opens the applied-plan bucket at the current version with the shared migrator", async () => {
    const opens: Array<{ version: number; onVersionMismatch: unknown }> = [];
    const state: PluginStateStore = {
      open: (spec) => {
        opens.push({ version: spec.version, onVersionMismatch: spec.onVersionMismatch });
        return Effect.die("recorded");
      },
      withLock: (_key, body) => body,
    };

    await Effect.runPromiseExit(inspectAppliedPlan(state, AppId.make("example")));

    expect(opens).toHaveLength(1);
    expect(opens[0]?.version).toBe(APPLIED_STATE_VERSION);
    expect(APPLIED_STATE_VERSION).toBe(8);
    // Strict throw adaptation: unconvertible historical payloads throw instead of returning null.
    expect(typeof opens[0]?.onVersionMismatch).toBe("function");
    const migrate = opens[0]?.onVersionMismatch as (raw: unknown, version: number) => unknown;
    expect(() => migrate({ not: "a plan" }, 1)).toThrow(/Cannot read applied state v1 as v8/);
  });

  test("reports unreadable when migration throws for an unconvertible v1 plan", async () => {
    const appId = AppId.make("broken");
    const state: PluginStateStore = {
      open: (spec) =>
        Effect.succeed({
          path: AbsolutePath.make("/tmp/plugin-state/applied-plans/broken.json"),
          exists: Effect.succeed(true),
          get: Effect.sync(() => {
            const migrate = spec.onVersionMismatch;
            if (typeof migrate !== "function") return null;
            // Simulate bucket handing the migrator a v1 payload with an accelerated non-app bind.
            // Strict throw adaptation: onVersionMismatch throws; the real bucket surfaces that as null/fail.
            try {
              return migrate(
                {
                  id: "broken",
                  name: "broken",
                  slug: "broken",
                  root: "/tmp/broken",
                  provider: "lando",
                  services: {
                    web: {
                      name: "web",
                      type: "web",
                      provider: "lando",
                      primary: true,
                      environment: {},
                      mounts: [
                        {
                          type: "bind",
                          source: "/x",
                          target: "/x",
                          readOnly: false,
                          realization: "accelerated",
                        },
                      ],
                      storage: [],
                      endpoints: [],
                      routes: [],
                      dependsOn: [],
                      hostAliases: [],
                      metadata: {
                        resolvedAt: "2026-10-23T00:00:00.000Z",
                        source: "test",
                        runtime: 4,
                      },
                      extensions: {},
                    },
                  },
                  networks: [],
                  routes: [],
                  stores: [],
                  fileSync: [],
                  metadata: {
                    resolvedAt: "2026-10-23T00:00:00.000Z",
                    source: "test",
                    runtime: 4,
                  },
                  extensions: {},
                },
                1,
              );
            } catch {
              return null;
            }
          }),
          set: () => Effect.die("unused"),
          update: () => Effect.die("unused"),
          mutate: () => Effect.die("this fixture does not support mutate"),
          transition: () => Effect.die("this fixture does not support transition"),
          modify: () => Effect.die("unused"),
          remove: Effect.die("unused"),
        }),
      withLock: (_key, body) => body,
    };

    const result = await Effect.runPromise(inspectAppliedPlan(state, appId));
    expect(result).toEqual({ status: "unreadable", path: "/tmp/plugin-state/applied-plans/broken.json" });
  });

  test("reports readable when migration converts a v1 appMount plan", async () => {
    const appId = AppId.make("values");
    const state: PluginStateStore = {
      open: (spec) =>
        Effect.succeed({
          path: AbsolutePath.make("/tmp/plugin-state/applied-plans/values.json"),
          exists: Effect.succeed(true),
          get: Effect.sync(() => {
            const migrate = spec.onVersionMismatch;
            if (typeof migrate !== "function") return null;
            return migrate(
              {
                id: "values",
                name: "values",
                slug: "values",
                root: "/tmp/lando-values",
                provider: "lando",
                services: {
                  web: {
                    name: "web",
                    type: "web",
                    provider: "lando",
                    primary: true,
                    environment: {},
                    appMount: {
                      source: "/tmp/lando-values",
                      target: "/app",
                      readOnly: false,
                      realization: "accelerated",
                      excludes: ["node_modules"],
                      includes: [],
                    },
                    mounts: [{ type: "tmpfs", target: "/scratch", readOnly: false }],
                    storage: [
                      {
                        store: "db",
                        target: "/var/lib/db",
                        readOnly: false,
                      },
                    ],
                    endpoints: [],
                    routes: [],
                    dependsOn: [],
                    hostAliases: [],
                    metadata: {
                      resolvedAt: "2026-10-23T00:00:00.000Z",
                      source: "test",
                      runtime: 4,
                    },
                    extensions: {},
                  },
                },
                networks: [],
                routes: [],
                stores: [{ name: "db", scope: "app", kind: "data" }],
                fileSync: [],
                metadata: {
                  resolvedAt: "2026-10-23T00:00:00.000Z",
                  source: "test",
                  runtime: 4,
                },
                extensions: {},
              },
              1,
            );
          }),
          set: () => Effect.die("unused"),
          update: () => Effect.die("unused"),
          mutate: () => Effect.die("this fixture does not support mutate"),
          transition: () => Effect.die("this fixture does not support transition"),
          modify: () => Effect.die("unused"),
          remove: Effect.die("unused"),
        }),
      withLock: (_key, body) => body,
    };

    const result = await Effect.runPromise(inspectAppliedPlan(state, appId));
    expect(result.status).toBe("readable");
    if (result.status !== "readable") return;
    const plan: AppPlan = result.plan;
    const mounts = plan.services[ServiceName.make("web")]?.mounts ?? [];
    expect(mounts.map((m) => String(m.target))).toEqual(["/app", "/scratch", "/var/lib/db"]);
    expect(mounts[0]).toMatchObject({
      type: "bind",
      role: "app",
      mountKey: "app-mount",
      realization: "accelerated",
    });
  });
});
