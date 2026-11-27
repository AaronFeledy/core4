import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortNumber,
  PortablePath,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
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
type TestProvider = ReturnType<typeof makeTestRuntimeProvider>;

const withPassword = (base: AppPlan, password: string): AppPlan => ({
  ...base,
  services: {
    [service]: {
      ...database,
      connection: { ...database.connection, creds: { ...database.connection.creds, password } },
      environment: { ...database.environment, LANDO_DB_PASSWORD: password },
    },
  },
});

const boundTo = Effect.fnUntraced(function* (provider: TestProvider, plan: AppPlan) {
  const target = { app: plan.id, service, plan };
  const { containerId } = yield* provider.inspect(target);
  const observe = provider.observeBoundVolume;
  if (containerId === undefined || observe === undefined)
    throw new TypeError("The fixture must support bound observation.");
  const bound = { ...target, expectedContainerId: containerId };
  const readVolume = () => observe(bound, destination);
  const volume = yield* readVolume();
  const login = (password: string) =>
    provider.exec(bound, {
      command: ["sh", "-ec", "psql ...\nprintf 'lando-matched\\n'"],
      env: {
        FAMILY: "postgres",
        PORT: "5432",
        USER_NAME: "db_user",
        DATABASE: "app_db",
        PASSWORD: password,
        ROOT_PASSWORD: "",
        ADMIN_PASSWORD: "",
      },
    });
  return { volume, readVolume, login };
});

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
        const changedPlan = withPassword(plan, changedPassword);
        yield* provider.apply(changedPlan, { reconcile: false });
        const { login } = yield* boundTo(provider, changedPlan);
        expect((yield* login(password)).exitCode).toBe(0);
        expect((yield* login(changedPassword)).exitCode).toBe(1);
      }),
    ),
  );
});

test("a shared provider isolates service volumes with the same store name by app", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = makeTestRuntimeProvider();
        const otherPassword = "other-app-password";
        const other = withPassword(
          {
            ...plan,
            id: AppId.make("other-app"),
            root: AbsolutePath.make("/tmp/other-app"),
          },
          otherPassword,
        );
        yield* provider.apply(plan, { reconcile: false });
        yield* provider.apply(other, { reconcile: false });

        const first = yield* boundTo(provider, plan);
        const second = yield* boundTo(provider, other);
        expect(second.volume.ref).toEqual({ app: other.id, store, scope: "service" });
        expect(second.volume.identity?.ownerRoot).toBe(other.root);
        expect(second.volume.instanceId).not.toBe(first.volume.instanceId);
        expect(second.volume.identity?.coordinationKey).not.toBe(first.volume.identity?.coordinationKey);
        expect(yield* provider.listVolumes({ app: other.id, store })).toEqual([second.volume]);
        expect((yield* provider.locateVolume(second.volume.ref)).identity).toEqual(second.volume.identity);
        expect((yield* first.login(password)).exitCode).toBe(0);
        expect((yield* first.login(otherPassword)).exitCode).toBe(1);
        expect((yield* second.login(otherPassword)).exitCode).toBe(0);
        expect((yield* second.login(password)).exitCode).toBe(1);
      }),
    ),
  );
});

test("public removal replaces a service volume generation and its initialized credentials", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = makeTestRuntimeProvider();
        yield* provider.apply(plan, { reconcile: false });
        const first = yield* boundTo(provider, plan);
        const generation = first.volume.instanceId;
        if (generation === undefined) throw new TypeError("The fixture did not assign a volume generation.");
        yield* provider.removeVolume(first.volume.ref, generation);
        expect(yield* provider.listVolumes({ app: plan.id, store, scope: "service" })).toEqual([]);
        expect(yield* provider.locateVolume(first.volume.ref)).toMatchObject({ presence: "absent" });
        expect((yield* Effect.flip(first.readVolume()))._tag).toBe("VolumeOperationError");
        expect((yield* first.login(password)).exitCode).toBe(1);
        yield* provider.bringDown({ app: plan.id, plan }, { containers: "remove", volumes: false });

        const newPassword = "recreated-password";
        const changed = withPassword(plan, newPassword);
        yield* provider.apply(changed, { reconcile: false });
        const second = yield* boundTo(provider, changed);
        expect(second.volume.ref).toEqual(first.volume.ref);
        const recreatedGeneration = second.volume.instanceId;
        if (recreatedGeneration === undefined)
          throw new TypeError("The fixture did not recreate the volume.");
        expect(recreatedGeneration).not.toBe(generation);
        expect((yield* second.login(newPassword)).exitCode).toBe(0);
        expect((yield* second.login(password)).exitCode).toBe(1);
        // An omitted ref scope addresses app storage, not service storage.
        yield* provider.removeVolume({ app: plan.id, store }, recreatedGeneration);
        const stale = yield* Effect.flip(provider.removeVolume(first.volume.ref, generation));
        expect(stale._tag).toBe("VolumeOperationError");
        expect(yield* provider.listVolumes({ app: plan.id, store, scope: "service" })).toEqual([
          second.volume,
        ]);
      }),
    ),
  );
});
