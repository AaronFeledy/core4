import { expect, test } from "bun:test";
import { PortablePath, ServiceName, type ServiceRunStatus } from "@lando/sdk/schema";
import { Effect } from "effect";
import { advanceGlobalRecordedPlan } from "../../src/operations/global-recorded-plan.ts";
import { serviceGroups } from "../../src/operations/global-service-groups.ts";
import { desired, fixture, observation, oldBridge } from "./global-sibling-fixture.ts";

test("idle unrecorded cleanup keeps independent selected services in separate groups", async () => {
  const mail = desired.services[ServiceName.make("mail")];
  const sibling = desired.services[ServiceName.make("sibling")];
  if (mail === undefined || sibling === undefined) throw new Error("Missing fixture services");
  const other = { ...sibling, name: ServiceName.make("other") };
  const result = await fixture({
    desired: { ...desired, services: { [mail.name]: { ...mail, dependsOn: [] }, [other.name]: other } },
    observed: [observation("exited")],
  }).reconcile((ids) => new Set([...ids, "other"]));
  if (result._tag === "Failure") throw result.failure;
  expect(result.success.removals.map((removal) => removal.binding)).toEqual([["sibling", "mail"]]);
  expect(
    serviceGroups([{ ...mail, dependsOn: [] }, other], result.success.bindings).map((group) =>
      group.map((service) => String(service.name)),
    ),
  ).toEqual([["mail"], ["other"]]);
});

const rows: readonly {
  readonly name: string;
  readonly owned: boolean;
  readonly recorded: boolean;
  readonly status: ServiceRunStatus;
  readonly conflicts: boolean;
  readonly selectable: boolean;
  readonly action: "ignore" | "retain" | "join" | "remove" | "fail";
}[] = [
  {
    name: "unproven active",
    owned: false,
    recorded: false,
    status: "running",
    conflicts: false,
    selectable: true,
    action: "fail",
  },
  {
    name: "unproven idle",
    owned: false,
    recorded: true,
    status: "exited",
    conflicts: true,
    selectable: true,
    action: "ignore",
  },
  {
    name: "unproven uncertain",
    owned: false,
    recorded: true,
    status: "unknown",
    conflicts: true,
    selectable: true,
    action: "ignore",
  },
  {
    name: "unrecorded active selectable",
    owned: true,
    recorded: false,
    status: "running",
    conflicts: false,
    selectable: true,
    action: "join",
  },
  {
    name: "unrecorded active unavailable",
    owned: true,
    recorded: false,
    status: "running",
    conflicts: false,
    selectable: false,
    action: "remove",
  },
  {
    name: "unrecorded idle",
    owned: true,
    recorded: false,
    status: "exited",
    conflicts: false,
    selectable: true,
    action: "remove",
  },
  {
    name: "unrecorded uncertain",
    owned: true,
    recorded: false,
    status: "removing",
    conflicts: false,
    selectable: true,
    action: "ignore",
  },
  {
    name: "compatible active",
    owned: true,
    recorded: true,
    status: "running",
    conflicts: false,
    selectable: true,
    action: "retain",
  },
  {
    name: "compatible idle",
    owned: true,
    recorded: true,
    status: "exited",
    conflicts: false,
    selectable: true,
    action: "retain",
  },
  {
    name: "compatible uncertain",
    owned: true,
    recorded: true,
    status: "unknown",
    conflicts: false,
    selectable: true,
    action: "retain",
  },
  {
    name: "conflicting active selectable",
    owned: true,
    recorded: true,
    status: "running",
    conflicts: true,
    selectable: true,
    action: "join",
  },
  {
    name: "conflicting active disabled",
    owned: true,
    recorded: true,
    status: "running",
    conflicts: true,
    selectable: false,
    action: "fail",
  },
  {
    name: "conflicting idle",
    owned: true,
    recorded: true,
    status: "exited",
    conflicts: true,
    selectable: false,
    action: "remove",
  },
  {
    name: "conflicting uncertain",
    owned: true,
    recorded: true,
    status: "unknown",
    conflicts: true,
    selectable: true,
    action: "fail",
  },
];

for (const row of rows)
  test(`sibling reconciliation: ${row.name} -> ${row.action}`, async () => {
    const observed = observation(row.status);
    const result = await fixture({
      ...(row.recorded ? { prior: row.conflicts ? oldBridge : desired } : {}),
      observed: [row.owned ? observed : { ...observed, labels: {} }],
      disabled: !row.selectable,
    }).reconcile();
    if (row.action === "fail") {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          _tag: "GlobalAppError",
          message: expect.stringContaining("sibling-container"),
        });
      return;
    }
    expect(result._tag).toBe("Success");
    if (result._tag === "Failure") throw result.failure;
    expect(result.success.selectedIds.sort()).toEqual(row.action === "join" ? ["mail", "sibling"] : ["mail"]);
    expect(result.success.removals.map(({ observation }) => observation.containerId)).toEqual(
      row.action === "remove" ? ["sibling-container"] : [],
    );
    expect(result.success.retainedIds).toEqual(row.action === "retain" ? ["sibling"] : []);
    expect(Object.keys(result.success.recordedPlan.services)).toEqual(
      // A removal target keeps its recorded metadata until the group that removes it succeeds.
      row.recorded && row.action !== "ignore" ? ["sibling"] : [],
    );
  });

test("strict prior read rejects unreadable state before observations", async () => {
  const f = fixture({ unreadable: true });
  const result = await f.reconcile();
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure")
    expect(result.failure).toMatchObject({
      _tag: "ProviderUnavailableError",
      operation: "applied-state.read",
    });
  expect(f.lists()).toBe(0);
});

test("a joined sibling closure rescues a dependency previously marked for removal", async () => {
  const result = await fixture({ observed: [observation("exited", "database"), observation()] }).reconcile(
    (ids) => new Set([...ids, ...(ids.has("sibling") ? ["database"] : [])]),
  );
  expect(result._tag).toBe("Success");
  if (result._tag === "Failure") throw result.failure;
  expect(result.success.selectedIds.sort()).toEqual(["database", "mail", "sibling"]);
  expect(result.success.removals).toEqual([]);
});

test.each(["authored network", "store", "route"] as const)(
  "conflicting %s binds the joined sibling to its selected owner",
  async (resource) => {
    const mail = desired.services[ServiceName.make("mail")];
    const sibling = desired.services[ServiceName.make("sibling")];
    if (mail === undefined || sibling === undefined) throw new Error("Missing services");
    const mount = {
      type: "volume" as const,
      store: "shared",
      target: PortablePath.make("/data"),
      readOnly: false,
    };
    const route = {
      hostname: "shared.test",
      service: mail.name,
      scheme: "http" as const,
      endpoint: 80,
      priority: 1,
      backend: { service: mail.name, protocol: "http" as const, port: 80 },
    };
    const current = {
      ...desired,
      services: {
        [mail.name]: { ...mail, mounts: [mount], routes: resource === "route" ? [{ index: 0 }] : [] },
        [sibling.name]: sibling,
      },
      routes: resource === "route" ? [route] : [],
      stores:
        resource === "store"
          ? [{ name: "shared", kind: "data" as const, scope: "app" as const, driver: "new" }]
          : [],
      networking: {
        perAppBridge: null,
        authoredNetworks:
          resource === "authored network"
            ? [
                {
                  key: "shared",
                  name: "shared",
                  external: false,
                  driver: "new",
                  members: { [mail.name]: { aliases: [] } },
                },
              ]
            : [],
      },
    };
    const prior = {
      ...desired,
      services: {
        [sibling.name]: { ...sibling, mounts: [mount], routes: resource === "route" ? [{ index: 0 }] : [] },
      },
      routes:
        resource === "route"
          ? [{ ...route, service: sibling.name, backend: { ...route.backend, service: sibling.name } }]
          : [],
      stores:
        resource === "store"
          ? [{ name: "shared", kind: "data" as const, scope: "app" as const, driver: "old" }]
          : [],
      networking: {
        perAppBridge: null,
        authoredNetworks:
          resource === "authored network"
            ? [
                {
                  key: "shared",
                  name: "shared",
                  external: false,
                  driver: "old",
                  members: { [sibling.name]: { aliases: [] } },
                },
              ]
            : [],
      },
    };
    const result = await fixture({ desired: current, prior }).reconcile();
    expect(result._tag).toBe("Success");
    if (result._tag === "Failure") throw result.failure;
    expect(result.success.bindings).toContainEqual(["sibling", "mail"]);
    expect(result.success.joinedIds).toEqual(["sibling"]);
  },
);

test("selected services recorded on a retired network advance as one group", async () => {
  // Given every service selected explicitly while its recorded realization still uses the old bridge.
  const ids = ["mail", "database", "sibling"];
  const result = await fixture({
    prior: oldBridge,
    observed: ids.map((id) => observation("exited", id)),
  }).reconcile(undefined, ids);
  expect(result._tag).toBe("Success");
  if (result._tag === "Failure") throw result.failure;
  // Then the migration binds them, so no group advances against another group's old networking.
  const groups = serviceGroups(Object.values(desired.services), result.success.bindings);
  expect(groups.map((group) => group.map((service) => String(service.name)).sort())).toEqual([
    ["database", "mail", "sibling"],
  ]);
  const built = { ...desired, services: Object.fromEntries(groups[0]?.map((s) => [s.name, s]) ?? []) };
  const advanced = await Effect.runPromise(
    Effect.result(advanceGlobalRecordedPlan(result.success.recordedPlan, built, [])),
  );
  expect(advanced._tag).toBe("Success");
});

test("an independent group keeps a pending removal target's recorded networking", async () => {
  // Given an exited sibling on authored network `shared` that conflicts only with mail.
  const mail = desired.services[ServiceName.make("mail")];
  const database = desired.services[ServiceName.make("database")];
  const sibling = desired.services[ServiceName.make("sibling")];
  if (mail === undefined || database === undefined || sibling === undefined)
    throw new Error("Missing services");
  const independentMail = { ...mail, dependsOn: [] };
  const network = (driver: string, member: string) => ({
    key: "shared",
    name: "shared",
    external: false,
    driver,
    members: { [member]: { aliases: [] } },
  });
  const current = {
    ...desired,
    services: { [mail.name]: independentMail, [database.name]: database, [sibling.name]: sibling },
    networking: { perAppBridge: null, authoredNetworks: [network("new", "mail")] },
  };
  const prior = {
    ...desired,
    services: { [sibling.name]: sibling },
    networking: { perAppBridge: null, authoredNetworks: [network("old", "sibling")] },
  };
  const result = await fixture({ desired: current, prior, observed: [observation("exited")] }).reconcile(
    undefined,
    ["mail", "database"],
  );
  expect(result._tag).toBe("Success");
  if (result._tag === "Failure") throw result.failure;
  expect(result.success.removals.map((removal) => removal.binding)).toEqual([["sibling", "mail"]]);
  // When only the unrelated database group applies (mail's build failed before the removal).
  const advanced = await Effect.runPromise(
    advanceGlobalRecordedPlan(
      result.success.recordedPlan,
      { ...current, services: { [database.name]: database } },
      [],
    ),
  );
  // Then the still-present sibling keeps its recorded service and network membership.
  expect(Object.keys(advanced.services).sort()).toEqual(["database", "sibling"]);
  expect(advanced.networking?.authoredNetworks).toEqual([network("old", "sibling")]);
});

test("reconciliation announces each sibling it recreates or removes, and nothing it rescues", async () => {
  // Given a running sibling and a stopped dependency, both recorded on the retired bridge.
  const f = fixture({
    prior: oldBridge,
    observed: [observation("exited", "database"), observation("running", "sibling")],
  });
  // When joining the sibling pulls the dependency back into the selection.
  const result = await f.reconcile((ids) => new Set([...ids, ...(ids.has("sibling") ? ["database"] : [])]));
  expect(result._tag).toBe("Success");
  // Then one notice names the recreated sibling and the network it leaves; the rescued dependency gets none.
  expect(f.notices()).toEqual([expect.stringContaining("lando-global")]);
  expect(f.notices()[0]).toContain("sibling");
  expect(f.notices()[0]).not.toContain("database");
});

test("a removed sibling is announced by name", async () => {
  const f = fixture({ prior: oldBridge, observed: [observation("exited")] });
  const result = await f.reconcile();
  expect(result._tag).toBe("Success");
  if (result._tag === "Failure") throw result.failure;
  expect(result.success.removals).toHaveLength(1);
  expect(f.notices()).toEqual([expect.stringContaining("sibling")]);
  expect(f.notices()[0]).toContain("lando-global");
});
