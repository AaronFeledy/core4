import { expect, test } from "bun:test";
import { migrateAppliedPlan, migrateAppliedPlansRecord } from "@lando/container-runtime/applied-state";
import { AppPlan, ServiceName, planAppIdentity } from "@lando/sdk/schema";
import { Schema } from "effect";
import { plan, service } from "./fixtures/environment-values.ts";

const encoded = Schema.encodeSync(AppPlan)(plan);
const web = Schema.encodeSync(AppPlan)(plan).services[service.name];
if (web === undefined) throw new Error("Missing fixture service");
const legacy = {
  ...encoded,
  services: {
    web: {
      ...web,
      hostAliases: [
        { hostname: "valid_alias", ip: "127.0.0.2" },
        { hostname: "bad host", ip: "127.0.0.3" },
      ],
      certs: {
        cn: "*-x.lndo.site",
        sans: ["*-x.lndo.site", "*.lndo.site", "wild.*.x.lndo.site", "localhost", "::1"],
        caId: "historical",
      },
    },
    worker: { ...web, name: "worker", primary: false },
  },
};

test.each([1, 2, 3])("migrates v%s names without changing other persisted fields or ownership", (version) => {
  const before = JSON.stringify(legacy);

  const result = migrateAppliedPlan(legacy, version);

  if (result === null) throw new Error("Historical names did not migrate");
  expect(Schema.encodeSync(AppPlan)(result)).toEqual({
    ...legacy,
    services: {
      ...legacy.services,
      web: {
        ...legacy.services.web,
        hostAliases: [{ hostname: "valid_alias", ip: "127.0.0.2" }],
        certs: { cn: "*.lndo.site", sans: ["*.lndo.site", "localhost", "::1"], caId: "historical" },
      },
    },
  });
  expect(planAppIdentity(result)).toEqual(planAppIdentity(plan));
  expect(JSON.stringify(legacy)).toBe(before);
});

test.each([
  { certs: { cn: "wild.*.x.lndo.site", sans: [], caId: "historical" } },
  { certs: { cn: "valid.test", sans: [7], caId: "historical" } },
  { hostAliases: [{ hostname: "bad host", ip: 7 }] },
  { hostAliases: [{ hostname: 7, ip: "127.0.0.2" }] },
  { mounts: [{ type: "unknown", target: "/data" }] },
])("refuses unconvertible v3 fields and the whole aggregate: %j", (fields) => {
  const invalid = { ...legacy, services: { web: { ...legacy.services.web, ...fields } } };
  const before = JSON.stringify(invalid);

  expect(migrateAppliedPlan(invalid, 3)).toBeNull();
  expect(migrateAppliedPlansRecord({ valid: legacy, invalid }, 3)).toBeNull();
  expect(JSON.stringify(invalid)).toBe(before);
});

test("leaves native v3 init intent untouched", () => {
  const raw = {
    ...encoded,
    services: { web: { ...web, init: false, extensions: { compose: { init: true } } } },
  };

  const result = migrateAppliedPlan(raw, 3);

  expect(result?.services[ServiceName.make("web")]?.init).toBe(false);
  expect(result?.services[ServiceName.make("web")]?.extensions).toEqual({ compose: { init: true } });
});

test("carries v4 plans forward unchanged", () => {
  const result = migrateAppliedPlan(encoded, 4);

  if (result === null) throw new Error("v4 plan did not migrate");
  expect(Schema.encodeSync(AppPlan)(result)).toEqual(encoded);
  expect(migrateAppliedPlansRecord({ example: encoded }, 4)).not.toBeNull();
});

test("refuses a v4 service that pairs a SQLite file with a database connection", () => {
  const contradictory = {
    ...encoded,
    services: {
      web: {
        ...web,
        sqlite: { path: "data/site.sqlite" },
        connection: {
          family: "mysql",
          creds: { user: "lando", password: "lando", database: "lando" },
          port: 3306,
        },
      },
    },
  };

  expect(migrateAppliedPlan(contradictory, 4)).toBeNull();
  expect(migrateAppliedPlansRecord({ valid: encoded, contradictory }, 4)).toBeNull();
});
