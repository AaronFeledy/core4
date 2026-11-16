import { expect, test } from "bun:test";
import {
  type AppPlan,
  type DatabaseConnection,
  PortNumber,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { CommandSpec, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import {
  connectionChanged,
  databaseCredentialCheckScope,
} from "../../src/operations/database-credentials.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { appliedPlanRecord, makeHarness, plan, runStart, web } from "./start-progress-topology-support.ts";

const dbName = ServiceName.make("db");

const connection = (
  overrides: Partial<DatabaseConnection["creds"]> = {},
  port = 3306,
): DatabaseConnection => ({
  family: "mariadb",
  port: PortNumber.make(port),
  creds: { user: "lando", password: "original", database: "appdb", ...overrides },
});

/** A planned database service that carries `web`'s artifact, command, and one published listener. */
const dbService = (overrides: Partial<DatabaseConnection["creds"]> = {}, port = 3306): ServicePlan => ({
  name: dbName,
  type: "mariadb",
  provider: plan.provider,
  primary: true,
  ...(web.artifact === undefined ? {} : { artifact: web.artifact }),
  ...(web.command === undefined ? {} : { command: web.command }),
  environment: {},
  mounts: [],
  endpoints: [
    {
      _tag: "published",
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
  extensions: {},
  connection: connection(overrides, port),
});

const dbPlan = (overrides: Partial<DatabaseConnection["creds"]> = {}): AppPlan => {
  const service = dbService(overrides);
  return { ...plan, services: { [service.name]: service } };
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

const withoutDatabase = (source: AppPlan): AppPlan => ({ ...source, services: { [web.name]: web } });

/** The database client command starts with the family client, so those are the check execs. */
const checkCalls = (calls: ReadonlyArray<CommandSpec>) =>
  calls.filter((call) => call.command[0] === "mariadb");

const startScope = (options: {
  readonly desired?: AppPlan;
  readonly previousPlan?: AppPlan;
  readonly before?: ServiceRuntimeInfo;
  readonly afterContainerId?: string;
}): readonly string[] => {
  const desired = options.desired ?? dbPlan();
  return databaseCredentialCheckScope({
    plan: desired,
    ...(options.previousPlan === undefined ? {} : { previousPlan: options.previousPlan }),
    before: options.before === undefined ? [] : [options.before],
    after: new Map([[String(dbName), observation(desired, dbName, options.afterContainerId ?? "c1")]]),
  });
};

test("a running, unchanged database service is outside the start check scope", () => {
  const desired = dbPlan();
  expect(
    startScope({
      previousPlan: desired,
      before: observation(desired, dbName, "c1"),
      afterContainerId: "c1",
    }),
  ).toEqual([]);
});

test("a database service this operation started or created is in scope", () => {
  const desired = dbPlan();
  expect(startScope({ previousPlan: desired, before: observation(desired, dbName, "c1", "exited") })).toEqual(
    ["db"],
  );
  expect(startScope({ previousPlan: desired })).toEqual(["db"]);
});

test("a database service this operation recreated is in scope", () => {
  const desired = dbPlan();
  expect(
    startScope({ previousPlan: desired, before: observation(desired, dbName, "c1"), afterContainerId: "c2" }),
  ).toEqual(["db"]);
});

test("a database service with no pre-apply applied plan entry is in scope", () => {
  const desired = dbPlan();
  expect(startScope({ before: observation(desired, dbName, "c1") })).toEqual(["db"]);
  expect(
    startScope({ previousPlan: withoutDatabase(desired), before: observation(desired, dbName, "c1") }),
  ).toEqual(["db"]);
});

test("a changed connection descriptor puts a running database service in scope", () => {
  const desired = dbPlan({ password: "changed" });
  expect(startScope({ desired, previousPlan: dbPlan(), before: observation(desired, dbName, "c1") })).toEqual(
    ["db"],
  );
  expect(connectionChanged(dbService(), dbService({ database: "other" }))).toBe(true);
  expect(connectionChanged(dbService(), dbService({}, 3307))).toBe(true);
  expect(connectionChanged(dbService(), dbService())).toBe(false);
});

test("a non-database service is never in the start check scope", () => {
  const desired = { ...plan, services: { [web.name]: web } };
  expect(
    databaseCredentialCheckScope({
      plan: desired,
      previousPlan: desired,
      before: [observation(desired, dbName, "c1")],
      after: new Map([[String(web.name), observation(desired, dbName, "c1")]]),
    }),
  ).toEqual([]);
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
    providerOverrides: {
      execStream: (_target, spec) => {
        calls.push(spec);
        return Stream.fromIterable([{ exitCode: 0 }]);
      },
      list: () => Effect.succeed(options.before === undefined ? [] : [options.before]),
    },
    inspect: (target) =>
      Effect.succeed(observation(desired, target.service, options.afterContainerId ?? "c1")),
    ...(applied === undefined
      ? {}
      : { resolveAppliedPlan: () => Effect.succeed(appliedPlanRecord(applied)) }),
  });
  await runStart(harness, desired);
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
  const alpha = { ...dbService(), name: ServiceName.make("alpha") };
  const beta = { ...dbService(), name: ServiceName.make("beta") };
  const desired: AppPlan = { ...plan, services: { [alpha.name]: alpha, [beta.name]: beta } };
  const checked: string[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    providerOverrides: {
      execStream: (target, spec) => {
        if (spec.command[0] === "mariadb") checked.push(String(target.service));
        return Stream.fromIterable([{ exitCode: 0 }]);
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
  await runStart(harness, desired);
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
    providerOverrides: {
      execStream: (_target, spec) => {
        calls.push(spec);
        return Stream.fromIterable([{ exitCode: 0 }]);
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
    operation({ services: [dbName] }, operationTarget(desired)).pipe(Effect.provide(harness.layer)),
  );
  return checkCalls(calls);
};

test("a selected restart always checks its running database service", async () => {
  expect(await selectedOperationWithDatabase(restartApp)).toHaveLength(1);
});

test("a selected rebuild always checks its running database service", async () => {
  expect(await selectedOperationWithDatabase(rebuildApp)).toHaveLength(1);
});
