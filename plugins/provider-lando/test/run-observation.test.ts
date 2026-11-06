import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { makeRuntimeProvider } from "./provider-fixture.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("run-observation");
const appRoot = AbsolutePath.make("/tmp/lando-run-observation");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-14T00:00:00Z"),
  source: "run-observation.test",
  runtime: 4 as const,
};
const web: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  id: appId,
  name: "Run observation",
  slug: "run-observation",
  root: appRoot,
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const labels = {
  "dev.lando.app": appId,
  "dev.lando.app-root": appRoot,
  "dev.lando.service": web.name,
};

const providerFor = (inspect: { readonly status: number; readonly state?: object }, listState?: string) => {
  const podmanApi: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.void,
    request: (input) =>
      Effect.succeed(
        input.path.startsWith("/containers/json?")
          ? {
              status: 200,
              body: JSON.stringify([
                {
                  Id: "c",
                  Names: ["c"],
                  Labels: labels,
                  ...(listState === undefined ? {} : { State: listState }),
                },
              ]),
            }
          : {
              status: inspect.status,
              body: JSON.stringify({ Id: "c", Config: { Labels: labels }, State: inspect.state }),
            },
      ),
  };
  return makeRuntimeProvider({ sanitizeAppliedPlan: stripHostProxyRunLando, platform: "linux", podmanApi });
};

test.each([
  [
    { Status: "running", Running: true, Health: { Status: "starting" } },
    { status: "running", health: "starting" },
  ],
  [{ Status: "running", Running: true }, { status: "running" }],
  [
    { Status: "exited", Running: false, ExitCode: 17 },
    { status: "exited", exitCode: 17 },
  ],
  [{ Status: "dead", Running: false, ExitCode: 1 }, { status: "dead" }],
  [{ Status: "created", Running: false, ExitCode: 0 }, { status: "created" }],
  [{ Status: "restarting", Running: true, ExitCode: 1 }, { status: "restarting" }],
  [{ Status: "paused", Running: true, Health: { Status: "healthy" } }, { status: "paused" }],
  [{}, { status: "unknown" }],
] as const)("Lando inspect %j reports %j", async (state, expected) => {
  const provider = await Effect.runPromise(providerFor({ status: 200, state }));
  const result = await Effect.runPromise(provider.inspect({ app: appId, service: web.name, plan }));
  expect(result).toMatchObject(expected);
  expect(result).not.toHaveProperty("state");
  if (expected.status !== "running") expect(result).not.toHaveProperty("health");
  if (expected.status !== "exited") expect(result).not.toHaveProperty("exitCode");
});

test("Lando inspect reports a missing container as absent", async () => {
  const provider = await Effect.runPromise(providerFor({ status: 404 }));
  const result = await Effect.runPromise(provider.inspect({ app: appId, service: web.name, plan }));
  expect(result).toMatchObject({ status: "absent" });
});

test.each([
  ["running", "running"],
  ["stopped", "exited"],
  ["configured", "created"],
  ["dead", "dead"],
  ["removing", "removing"],
  ["created", "created"],
  ["exited", "exited"],
  ["paused", "paused"],
  ["restarting", "restarting"],
  ["initialized", "created"],
  ["stopping", "unknown"],
] as const)("Lando discovery maps engine state %s to %s", async (raw, expected) => {
  const provider = await Effect.runPromise(providerFor({ status: 404 }, raw));
  const rows = await Effect.runPromise(provider.list({ app: appId, includeUnplanned: true }));
  expect(rows.map((row) => row.status)).toEqual([expected]);
  expect(rows[0]).not.toHaveProperty("state");
  expect(rows[0]).not.toHaveProperty("health");
  expect(rows[0]).not.toHaveProperty("exitCode");
});
