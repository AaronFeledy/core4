import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import {
  type AppPlan,
  type DatabaseConnection,
  PortNumber,
  PortablePath,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { CommandSpec, ServiceRuntimeInfo } from "@lando/sdk/services";
import { PathsService } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";
import { connectionChanged } from "../../src/operations/database-credentials.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { appliedPlanRecord, makeHarness, plan, runStart } from "./start-progress-topology-support.ts";

const dbName = ServiceName.make("db");

const connection = (
  overrides: Partial<DatabaseConnection["creds"]> = {},
  port = 3306,
): DatabaseConnection => ({
  family: "postgres",
  port: PortNumber.make(port),
  creds: { user: "lando", password: "original", database: "appdb", ...overrides },
});

const dbService = (overrides: Partial<DatabaseConnection["creds"]> = {}, port = 3306): ServicePlan => ({
  name: dbName,
  type: "postgres",
  serviceTypeId: "postgres",
  provider: plan.provider,
  primary: true,
  artifact: { kind: "ref", ref: "postgres:16" },
  environment: {},
  mounts: [
    {
      type: "volume",
      store: "db-data",
      target: PortablePath.make("/var/lib/postgresql/data"),
      readOnly: false,
    },
  ],
  endpoints: [
    {
      kind: "published",
      port: 3306,
      protocol: "tcp",
      name: "db",
      publication: { hostPort: 3306 },
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: plan.metadata,
  extensions: { "@lando/core/catalog-database": "postgres:16" },
  connection: connection(overrides, port),
});

const dbPlan = (overrides: Partial<DatabaseConnection["creds"]> = {}): AppPlan => {
  const service = dbService(overrides);
  return {
    ...plan,
    stores: [{ name: "db-data", kind: "data", scope: "service" }],
    services: { [service.name]: service },
  };
};

const observation = (
  source: AppPlan,
  service: ServiceName,
  containerId: string,
  status: ServiceRuntimeInfo["status"] = "running",
): ServiceRuntimeInfo => ({
  app: source.id,
  appRoot: source.root,
  service,
  providerId: source.provider,
  containerId,
  status,
  publications: {
    status: "present",
    bindings: [{ port: 3306, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 3306 }],
  },
});

const checkCalls = (calls: ReadonlyArray<CommandSpec>) =>
  calls.filter((call) => call.command[0] === "sh" && call.command[1] === "-ec");

const matched = () =>
  Stream.make(
    { kind: "stdout" as const, chunk: new TextEncoder().encode("lando-matched\n") },
    { exitCode: 0 },
  );
const volume = (source: AppPlan, service: ServiceName) => {
  const mount = source.services[service]?.mounts[0];
  const store = mount?.type === "volume" ? mount.store : `${service}-data`;
  return Effect.succeed({
    ref: { app: source.id, store },
    identity: {
      coordinationKey: store,
      nativeName: store,
      generation: "test-generation",
      ownerRoot: source.root,
      origin: "created" as const,
    },
  });
};

test("detects database name and port changes in connection descriptors", () => {
  expect(connectionChanged(dbService(), dbService({ database: "other" }))).toBe(true);
  expect(connectionChanged(dbService(), dbService({}, 3307))).toBe(true);
  expect(connectionChanged(dbService(), dbService())).toBe(false);
});

const startWithDatabase = async (options: {
  readonly desired?: AppPlan;
  readonly applied?: AppPlan;
  readonly before?: ServiceRuntimeInfo;
  readonly afterContainerId?: string;
}) => {
  const desired = options.desired ?? dbPlan();
  const applied = options.applied;
  const calls: CommandSpec[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    apply: () =>
      Effect.succeed({
        changed: true,
        services: {
          [dbName]: {
            action:
              options.before?.status === "exited"
                ? "started"
                : options.afterContainerId === "c2"
                  ? "replaced"
                  : "kept",
          },
        },
      }),
    providerOverrides: {
      observeVolume: ({ service }) => volume(desired, service),
      execStream: (_target, spec) => {
        calls.push(spec);
        return matched();
      },
      list: () => Effect.succeed(options.before === undefined ? [] : [options.before]),
    },
    inspect: (target) =>
      Effect.succeed(observation(desired, target.service, options.afterContainerId ?? "c1")),
    ...(applied === undefined
      ? {}
      : { resolveAppliedPlan: () => Effect.succeed(appliedPlanRecord(applied)) }),
  });
  await runStart(
    { ...harness, layer: harness.layer.pipe(Layer.merge(Layer.succeed(PathsService, makeLandoPaths()))) },
    desired,
  );
  return checkCalls(calls);
};

test("a no-op start of a running, unchanged database performs no check exec", async () => {
  const desired = dbPlan();
  expect(
    await startWithDatabase({
      desired,
      applied: desired,
      before: observation(desired, dbName, "c1"),
      afterContainerId: "c1",
    }),
  ).toEqual([]);
});

test("a start that starts the database service checks it", async () => {
  const desired = dbPlan();
  const calls = await startWithDatabase({
    desired,
    applied: desired,
    before: observation(desired, dbName, "c1", "exited"),
  });
  expect(calls).toHaveLength(1);
});

test("a start that recreated the database service checks it", async () => {
  const desired = dbPlan();
  const calls = await startWithDatabase({
    desired,
    applied: desired,
    before: observation(desired, dbName, "c1"),
    afterContainerId: "c2",
  });
  expect(calls).toHaveLength(1);
});

test("a start whose creds descriptor changed checks the running database", async () => {
  const desired = dbPlan({ password: "changed" });
  const calls = await startWithDatabase({
    desired,
    applied: dbPlan(),
    before: observation(desired, dbName, "c1"),
    afterContainerId: "c1",
  });
  expect(calls).toHaveLength(1);
});

test("a start checks only the database services whose answer can change", async () => {
  const named = (name: "alpha" | "beta"): ServicePlan => ({
    ...dbService(),
    name: ServiceName.make(name),
    mounts: [
      {
        type: "volume",
        store: `${name}-data`,
        target: PortablePath.make("/var/lib/postgresql/data"),
        readOnly: false,
      },
    ],
  });
  const alpha = named("alpha");
  const beta = named("beta");
  const desired: AppPlan = {
    ...plan,
    stores: ["alpha-data", "beta-data"].map((name) => ({ name, scope: "service", kind: "data" })),
    services: { [alpha.name]: alpha, [beta.name]: beta },
  };
  const checked: string[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    apply: () =>
      Effect.succeed({
        changed: true,
        services: { [alpha.name]: { action: "kept" }, [beta.name]: { action: "started" } },
      }),
    providerOverrides: {
      observeVolume: ({ service }) => volume(desired, service),
      execStream: (target, spec) => {
        if (checkCalls([spec]).length > 0) checked.push(String(target.service));
        return matched();
      },
      list: () =>
        Effect.succeed([
          observation(desired, alpha.name, "c-alpha"),
          observation(desired, beta.name, "c-beta", "exited"),
        ]),
    },
    inspect: (target) => Effect.succeed(observation(desired, target.service, `c-${target.service}`)),
    resolveAppliedPlan: () => Effect.succeed(appliedPlanRecord(desired)),
  });
  await runStart(
    { ...harness, layer: harness.layer.pipe(Layer.merge(Layer.succeed(PathsService, makeLandoPaths()))) },
    desired,
  );
  expect(checked).toEqual(["beta"]);
});

const operationTarget = (source: AppPlan) => ({
  plan: source,
  root: source.root,
  app: { kind: "user" as const, id: source.id, root: source.root },
});

const selectedOperationWithDatabase = async (operation: typeof restartApp | typeof rebuildApp) => {
  const desired = dbPlan();
  const calls: CommandSpec[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    apply: () => Effect.succeed({ changed: true, services: { [dbName]: { action: "started" } } }),
    providerOverrides: {
      observeVolume: ({ service }) => volume(desired, service),
      execStream: (_target, spec) => {
        calls.push(spec);
        return matched();
      },
      list: () => Effect.succeed([observation(desired, dbName, "c1")]),
    },
    inspect: (target) =>
      Effect.succeed(observation(desired, dbName, "c1")).pipe(
        Effect.map((runtime) => ({ ...runtime, service: target.service })),
      ),
    resolveAppliedPlan: () => Effect.succeed(appliedPlanRecord(desired)),
  });
  await Effect.runPromise(
    operation({ services: [dbName] }, operationTarget(desired)).pipe(
      Effect.provide(harness.layer),
      Effect.provideService(PathsService, makeLandoPaths()),
    ),
  );
  return checkCalls(calls);
};

test("a selected restart always checks its running database service", async () => {
  expect(await selectedOperationWithDatabase(restartApp)).toHaveLength(1);
});

test("a selected rebuild always checks its running database service", async () => {
  expect(await selectedOperationWithDatabase(rebuildApp)).toHaveLength(1);
});
