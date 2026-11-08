import { expect, test } from "bun:test";
import {
  type AppPlan,
  type BindMountPlan,
  type DataStorePlan,
  type MountPlan,
  PortablePath,
  ServiceName,
  type VolumeMountPlan,
} from "@lando/sdk/schema";
import { plan, web } from "./start-progress-topology-support.ts";
import { paths, runNotice, runTransition } from "./volume-transition-support.ts";

const volume = (store: string, origin?: MountPlan["origin"]): VolumeMountPlan => ({
  type: "volume",
  store,
  target: PortablePath.make("/var/lib/mysql"),
  readOnly: false,
  ...(origin === undefined ? {} : { origin }),
});
const dataPlan = (mounts: readonly MountPlan[], stores: readonly DataStorePlan[] = []): AppPlan => ({
  ...plan,
  stores,
  services: { [web.name]: { ...web, serviceTypeId: "node", mounts } },
});

for (const path of paths) {
  test.each(["service", "authored", undefined] as const)(
    `${path} names changed data volume with origin %s before apply`,
    async (origin) => {
      const previous = dataPlan(
        [volume("catalog-data-old", origin)],
        [{ name: "catalog-data-old", kind: "data", scope: "service" }],
      );
      const desired = dataPlan(
        [volume("catalog-data-new", origin)],
        [{ name: "catalog-data-new", kind: "data", scope: "service" }],
      );
      const { warnings, timeline } = await runTransition(path, previous, desired);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.body).toContain("catalog-data-new");
      expect(warnings[0]?.body).toContain(
        'storage: [{ store: "catalog-data-old", target: "/var/lib/mysql" }]',
      );
      expect(timeline.indexOf("warn")).toBeLessThan(timeline.indexOf("apply"));
    },
  );

  test(`${path} reports a removed data mount`, async () => {
    const { warnings } = await runTransition(
      path,
      dataPlan([volume("removed-data", "service")]),
      dataPlan([]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.body).toContain("removed-data");
    expect(warnings[0]?.body).toContain("/var/lib/mysql");
    expect(warnings[0]?.body).toContain('storage: [{ store: "removed-data", target: "/var/lib/mysql" }]');
  });

  test.each([
    ["derived", "data", "service"],
    ["integration", "data", "service"],
    ["service", "cache", "app"],
    ["authored", "cache", "global"],
    ["service", "data", "global"],
    [undefined, undefined, undefined],
    ["authored", undefined, undefined],
  ] as const)(`${path} ignores excluded volume %s/%s/%s`, async (origin, kind, scope) => {
    const previous = dataPlan(
      [volume("excluded-old", origin)],
      kind === undefined || scope === undefined ? [] : [{ name: "excluded-old", kind, scope }],
    );
    const desired = dataPlan(
      [volume("excluded-new", origin)],
      kind === undefined || scope === undefined ? [] : [{ name: "excluded-new", kind, scope }],
    );
    expect((await runTransition(path, previous, desired)).warnings).toEqual([]);
  });

  test(`${path} does not suggest reattaching data across service types`, async () => {
    const previous = dataPlan([volume("mysql-data", "service")]);
    const desired = dataPlan([volume("mariadb-data", "service")]);
    const { warnings } = await runTransition(
      path,
      {
        ...previous,
        services: {
          [web.name]: { ...web, type: "mysql", mounts: previous.services[web.name]?.mounts ?? [] },
        },
      },
      {
        ...desired,
        services: {
          [web.name]: { ...web, type: "mariadb", mounts: desired.services[web.name]?.mounts ?? [] },
        },
      },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.body).toContain("mysql-data");
    expect(warnings[0]?.body).toContain("mariadb-data");
    expect(warnings[0]?.body).not.toContain("storage:");
  });
}

test.each(["passthrough", "accelerated"] as const)("ignores %s bind changes", async (realization) => {
  const bind: BindMountPlan = {
    type: "bind",
    source: "/old",
    target: PortablePath.make("/app"),
    readOnly: false,
    realization,
    mountKey: "app",
  };
  expect(await runNotice(dataPlan([bind]), dataPlan([{ ...bind, source: "/new" }]))).toEqual([]);
});

test.each([
  ["mysql:8.0", "mysql", "mysql:8.4", "mysql", true],
  ["mysql:8.0", "mysql", "mariadb:11.4", "mariadb", false],
  ["compose", "mysql", "compose", "mariadb", false],
  ["mysql:8.0", undefined, "mysql:8.0", "mysql", false],
  ["mysql:8.0", undefined, "mysql:8.4", "mysql", false],
  ["mysql", "mysql", "mysql", undefined, false],
  ["mysql", undefined, "mysql", undefined, false],
] as const)("reattach advice for %s/%s -> %s/%s: %s", async (oldType, oldId, type, id, reattach) => {
  const previous = dataPlan([volume("old-data", "service")]);
  const desired = dataPlan([volume("new-data", "service")]);
  const warnings = await runNotice(
    {
      ...previous,
      services: {
        [web.name]: {
          ...web,
          type: oldType,
          ...(oldId === undefined ? {} : { serviceTypeId: oldId }),
          mounts: [volume("old-data", "service")],
        },
      },
    },
    {
      ...desired,
      services: {
        [web.name]: {
          ...web,
          type,
          ...(id === undefined ? {} : { serviceTypeId: id }),
          mounts: [volume("new-data", "service")],
        },
      },
    },
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.body.includes('storage: [{ store: "old-data", target: "/var/lib/mysql" }]')).toBe(
    reattach,
  );
});

test.each(["selected rebuild", "selected restart"] as const)(
  "%s reports only selected data changes",
  async (path) => {
    const extra = ServiceName.make("extra");
    const removed = ServiceName.make("removed");
    const previous = dataPlan([volume("web-old", "service")]);
    const desired = dataPlan([volume("web-new", "service")]);
    const { warnings } = await runTransition(
      path,
      {
        ...previous,
        services: {
          ...previous.services,
          [extra]: { ...web, name: extra, mounts: [volume("extra-old", "service")] },
          [removed]: { ...web, name: removed, mounts: [volume("removed-old", "service")] },
        },
      },
      {
        ...desired,
        services: {
          ...desired.services,
          [extra]: { ...web, name: extra, mounts: [volume("extra-new", "service")] },
        },
      },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.body).toContain("web-old");
    expect(warnings[0]?.body).not.toContain("extra-old");
    expect(warnings[0]?.body).not.toContain("removed-old");
  },
);

test("nested rebuild deduplicates each target separately and resets for a later command", async () => {
  const previous = dataPlan([
    volume("database-old", "service"),
    { ...volume("files-old", "service"), target: PortablePath.make("/files") },
  ]);
  const desired = dataPlan([
    volume("database-new", "service"),
    { ...volume("files-new", "service"), target: PortablePath.make("/files") },
  ]);
  const { warnings } = await runTransition("rebuild", previous, desired, 2);
  expect(warnings).toHaveLength(4);
  expect(warnings.filter((event) => event.body.includes('store: "database-old"'))).toHaveLength(2);
  expect(warnings.filter((event) => event.body.includes('store: "files-old"'))).toHaveLength(2);
});
