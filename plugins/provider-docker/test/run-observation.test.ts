import { expect, test } from "bun:test";
import { type DockerApiClient, makeRuntimeProvider } from "@lando/provider-docker";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";

const name = ServiceName.make("web");
const providerId = ProviderId.make("docker");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-27T00:00:00Z"),
  source: "test",
  runtime: 4,
} as const;
const service = {
  name,
  type: "lando",
  provider: providerId,
  primary: true,
  environment: {},
  mounts: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata,
  endpoints: [],
} as const satisfies ServicePlan;
const plan: AppPlan = {
  id: AppId.make("run-observation"),
  name: "run-observation",
  slug: "run-observation",
  root: AbsolutePath.make("/tmp/run-observation"),
  provider: providerId,
  services: { [name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata,
};

const providerFor = (state: object | undefined, listState?: string, inspectStatus = 200) => {
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: (input) =>
      Effect.succeed({
        status: input.path.startsWith("/containers/json") ? 200 : inspectStatus,
        body: input.path.startsWith("/containers/json")
          ? JSON.stringify([
              {
                Id: "c",
                Names: ["/c"],
                Status: "Up 3 minutes",
                ...(listState === undefined ? {} : { State: listState }),
                Labels: { "dev.lando.app": plan.id, "dev.lando.service": name },
              },
            ])
          : JSON.stringify({ Id: "c", ...(state === undefined ? {} : { State: state }) }),
      }),
  };
  return makeRuntimeProvider({ platform: "linux", dockerApi: api });
};

test.each([
  ["running", "running"],
  ["paused", "paused"],
  ["restarting", "restarting"],
  ["removing", "removing"],
  ["created", "created"],
  ["exited", "exited"],
  ["dead", "dead"],
  ["unrecognized", "unknown"],
] as const)("Docker list normalizes engine state %s to %s", async (raw, expected) => {
  const provider = await Effect.runPromise(providerFor({}, raw));
  const rows = await Effect.runPromise(provider.list({ app: plan.id }));
  expect(rows.map((row) => row.status)).toEqual([expected]);
  // The list endpoint carries neither a healthcheck verdict nor an exit code.
  expect(rows[0]).not.toHaveProperty("health");
  expect(rows[0]).not.toHaveProperty("exitCode");
  expect(rows[0]).not.toHaveProperty("state");
  expect(rows[0]).not.toHaveProperty("lastStartedAt");
});

test("Docker list reports a row without a state as unknown instead of stopped", async () => {
  const provider = await Effect.runPromise(providerFor({}));
  const rows = await Effect.runPromise(provider.list({ app: plan.id }));
  expect(rows.map((row) => row.status)).toEqual(["unknown"]);
});

test.each([
  [
    { Status: "running", Health: { Status: "healthy" } },
    { status: "running", health: "healthy" },
  ],
  [
    { Status: "running", Health: { Status: "starting" } },
    { status: "running", health: "starting" },
  ],
  [{ Status: "running" }, { status: "running" }],
  [
    { Status: "exited", ExitCode: 137 },
    { status: "exited", exitCode: 137 },
  ],
  [{ Status: "dead", ExitCode: 1 }, { status: "dead" }],
  [{ Status: "paused", Health: { Status: "healthy" } }, { status: "paused" }],
  [{ Status: "created", ExitCode: 0 }, { status: "created" }],
] as const)("Docker inspect %j carries only the evidence its state allows", async (state, expected) => {
  const provider = await Effect.runPromise(providerFor(state));
  const result = await Effect.runPromise(provider.inspect({ app: plan.id, service: name, plan }));
  expect(result).toMatchObject(expected);
  expect(result).not.toHaveProperty("state");
  if (expected.status !== "running") expect(result).not.toHaveProperty("health");
  if (expected.status !== "exited") expect(result).not.toHaveProperty("exitCode");
});

test("Docker inspect reports a missing container as absent", async () => {
  const provider = await Effect.runPromise(providerFor(undefined, undefined, 404));
  const result = await Effect.runPromise(provider.inspect({ app: plan.id, service: name, plan }));
  expect(result).toMatchObject({ status: "absent", mounts: { status: "missing" } });
});
