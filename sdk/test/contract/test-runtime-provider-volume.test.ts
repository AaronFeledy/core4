import { expect, test } from "bun:test";
import { type AppPlan, PortNumber, PortablePath, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { makeTestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { testProviderPlan } from "./test-provider-plan.ts";

const service = ServiceName.make("web");
const destination = PortablePath.make("/var/lib/postgresql/data");
const store = "test-postgres-data";
const password = "fixture-password";
const web = testProviderPlan.services[service];
if (web === undefined) throw new TypeError("The fixture requires a web service.");
const { nonSqlCreds: _nonSqlCreds, sqlite: _sqlite, ...template } = web;
const database = {
  ...template,
  mounts: [{ type: "volume", target: destination, store, readOnly: false }],
  connection: {
    family: "postgres",
    port: PortNumber.make(5432),
    creds: { user: "db_user", database: "app_db", password },
  },
  environment: { LANDO_DB_USER: "db_user", LANDO_DB_NAME: "app_db", LANDO_DB_PASSWORD: password },
} satisfies ServicePlan;
const plan = {
  ...testProviderPlan,
  stores: [{ name: store, kind: "data", scope: "service" }],
  services: { [service]: database },
} satisfies AppPlan;
const target = { app: plan.id, service, plan };

test("the fixture rejects a stale container id when observing an attached volume", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = makeTestRuntimeProvider();
        const observe = provider.observeBoundVolume;
        if (observe === undefined) throw new TypeError("The fixture cannot observe a bound volume.");
        yield* provider.apply(plan, { reconcile: false });
        const first = yield* provider.inspect(target);
        if (first.containerId === undefined) throw new TypeError("The fixture did not start a container.");
        yield* provider.bringDown({ app: plan.id, plan }, { containers: "remove", volumes: false });
        yield* provider.apply(plan, { reconcile: false });

        const stale = yield* Effect.flip(
          observe({ ...target, expectedContainerId: first.containerId }, destination),
        );
        expect(stale._tag).toBe("VolumeOperationError");
      }),
    ),
  );
});

test("the fixture does not attest to a changed password on the same data volume", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = makeTestRuntimeProvider();
        yield* provider.apply(plan, { reconcile: false });
        yield* provider.bringDown({ app: plan.id, plan }, { containers: "remove", volumes: false });
        const changedPassword = "changed-password";
        const changedPlan = {
          ...plan,
          services: {
            [service]: {
              ...database,
              connection: {
                ...database.connection,
                creds: { ...database.connection.creds, password: changedPassword },
              },
              environment: { ...database.environment, LANDO_DB_PASSWORD: changedPassword },
            },
          },
        } satisfies AppPlan;
        yield* provider.apply(changedPlan, { reconcile: false });
        const changedTarget = { ...target, plan: changedPlan };
        const { containerId } = yield* provider.inspect(changedTarget);
        if (containerId === undefined) throw new TypeError("The fixture did not start a container.");

        const login = (attempt: string) =>
          provider.exec(
            { ...changedTarget, expectedContainerId: containerId },
            {
              command: ["sh", "-ec", "psql ...\nprintf 'lando-matched\\n'"],
              env: {
                FAMILY: "postgres",
                PORT: "5432",
                USER_NAME: "db_user",
                DATABASE: "app_db",
                PASSWORD: attempt,
                ROOT_PASSWORD: "",
                ADMIN_PASSWORD: "",
              },
            },
          );
        expect((yield* login(password)).exitCode).toBe(0);
        expect((yield* login(changedPassword)).exitCode).toBe(1);
      }),
    ),
  );
});
