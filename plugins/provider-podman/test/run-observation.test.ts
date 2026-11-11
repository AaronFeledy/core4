import { expect, test } from "bun:test";
import { AppPlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { makeRuntimeProvider } from "./provider-fixture.ts";

const plan = Schema.decodeUnknownSync(AppPlan)({
  id: "run-observation",
  name: "Run observation",
  slug: "run-observation",
  root: "/run-observation",
  provider: "podman",
  services: {
    web: {
      name: "web",
      type: "compose",
      provider: "podman",
      primary: true,
      artifact: { kind: "ref", ref: "busybox:1.37" },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      extensions: {},
      metadata: { source: "run-observation", runtime: 4, resolvedAt: "2026-01-01T00:00:00Z" },
    },
  },
  stores: [],
  routes: [],
  fileSync: [],
  extensions: {},
  metadata: { source: "run-observation", runtime: 4, resolvedAt: "2026-01-01T00:00:00Z" },
});

const web = ServiceName.make("web");

const labels = {
  "dev.lando.app": plan.id,
  "dev.lando.app-root": plan.root,
  "dev.lando.service": "web",
};

const providerFor = (inspect: { readonly status: number; readonly state?: object }, listState?: string) =>
  makeRuntimeProvider({
    platform: "linux",
    env: {},
    conflictDetector: () => Effect.void,
    podmanApi: {
      info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
      ping: Effect.void,
      request: (input) => {
        if (input.path.startsWith("/containers/json?"))
          return Effect.succeed({
            status: 200,
            body: JSON.stringify([
              {
                Id: "c",
                Names: ["c"],
                Labels: labels,
                ...(listState === undefined ? {} : { State: listState }),
              },
            ]),
          });
        return Effect.succeed({
          status: inspect.status,
          body: JSON.stringify({ Id: "c", Config: { Labels: labels }, State: inspect.state }),
        });
      },
    },
  });

test.each([
  [
    { Status: "running", Running: true, Health: { Status: "unhealthy" } },
    { status: "running", health: "unhealthy" },
  ],
  [{ Status: "running", Running: true }, { status: "running" }],
  [
    { Status: "stopped", Running: false, ExitCode: 3 },
    { status: "exited", exitCode: 3 },
  ],
  [
    { Status: "exited", Running: false, ExitCode: 137 },
    { status: "exited", exitCode: 137 },
  ],
  [{ Status: "configured", Running: false, ExitCode: 0 }, { status: "created" }],
  [{ Status: "created", Running: false, ExitCode: 0 }, { status: "created" }],
  [{ Status: "paused", Running: true }, { status: "paused" }],
  [{ Status: "dead", Running: false, ExitCode: 0, Health: { Status: "healthy" } }, { status: "dead" }],
  [{ Status: "stopping", Running: true }, { status: "unknown" }],
] as const)("Podman inspect %j reports %j", async (state, expected) => {
  const provider = await Effect.runPromise(providerFor({ status: 200, state }));
  const result = await Effect.runPromise(provider.inspect({ app: plan.id, service: web, plan }));
  expect(result).toMatchObject(expected);
  expect(result).not.toHaveProperty("state");
  if (expected.status !== "running") expect(result).not.toHaveProperty("health");
  if (expected.status !== "exited") expect(result).not.toHaveProperty("exitCode");
});

test("Podman inspect reports a missing container as absent", async () => {
  const provider = await Effect.runPromise(providerFor({ status: 404 }));
  const result = await Effect.runPromise(provider.inspect({ app: plan.id, service: web, plan }));
  expect(result).toMatchObject({ status: "absent", mounts: { status: "missing" } });
});

test.each([
  ["running", "running"],
  ["stopped", "exited"],
  ["configured", "created"],
  ["exited", "exited"],
  ["paused", "paused"],
  ["dead", "dead"],
  ["removing", "removing"],
  ["restarting", "restarting"],
  ["initialized", "created"],
  ["stopping", "unknown"],
] as const)("Podman discovery maps engine state %s to %s", async (raw, expected) => {
  const provider = await Effect.runPromise(providerFor({ status: 404 }, raw));
  const rows = await Effect.runPromise(provider.list({ app: plan.id, includeUnplanned: true }));
  expect(rows.map((row) => row.status)).toEqual([expected]);
  expect(rows[0]).not.toHaveProperty("state");
  expect(rows[0]).not.toHaveProperty("health");
  expect(rows[0]).not.toHaveProperty("exitCode");
});
