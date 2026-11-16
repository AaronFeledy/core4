import { expect, test } from "bun:test";
import { mergeAppliedPlan } from "@lando/container-runtime/plan";
import { type AppPlan, type RoutePlan, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { selectedAppliedRecord } from "../../src/operations/selected-relaunch-record.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const db: ServicePlan = {
  ...web,
  name: ServiceName.make("db"),
  type: "postgres",
  primary: false,
  endpoints: [],
};
const gone: ServicePlan = { ...db, name: ServiceName.make("gone") };
const routeTo = (service: ServicePlan, hostname: string): RoutePlan => ({
  hostname,
  scheme: "http",
  service: service.name,
  priority: 2,
  backend: { service: service.name, port: 3000, protocol: "http" },
});
const policy = (mode: "ordinary" | "accelerated") => ({ mode, reason: "service-opt-out" as const });

/** A plan whose services run `node <command>` and reference the given routes by position. */
const appWith = (
  command: string,
  routes: ReadonlyArray<RoutePlan>,
  services: ReadonlyArray<ServicePlan>,
): AppPlan => ({
  ...plan,
  routes: [...routes],
  services: Object.fromEntries(
    services.map((service) => [
      service.name,
      {
        ...service,
        command: ["node", command],
        routes: routes.flatMap((route, index) => (route.service === service.name ? [{ index }] : [])),
      },
    ]),
  ),
});

const hostnames = (applied: AppPlan, service: ServiceName) =>
  (applied.services[service]?.routes ?? []).map((ref) => applied.routes[ref.index]?.hostname);

test("composes unselected applied routes with the selected service's desired routes", () => {
  // Given an applied record whose web, db, and since-removed gone ran old.js behind their routes.
  const previous: AppPlan = {
    ...appWith(
      "old.js",
      [routeTo(web, "web.test"), routeTo(db, "db.test"), routeTo(gone, "gone.test")],
      [web, db, gone],
    ),
    fileSyncPolicy: {
      reason: "service-opt-out",
      services: { web: policy("ordinary"), db: policy("ordinary"), gone: policy("ordinary") },
    },
  };
  // And a desired plan that moved web to a new hostname, changed db's route, and gave db a second one.
  const desired: AppPlan = {
    ...appWith(
      "new.js",
      [routeTo(web, "web-new.test"), routeTo(db, "db-new.test"), routeTo(db, "db-extra.test")],
      [web, db],
    ),
    fileSyncPolicy: {
      reason: "service-opt-out",
      services: { web: policy("accelerated"), db: policy("accelerated") },
    },
  };
  const desiredDb = desired.services[db.name];
  if (desiredDb === undefined) throw new Error("db is missing from the desired plan.");
  const runtime: AppPlan = {
    ...desired,
    services: { [db.name]: { ...desiredDb, command: ["node", "built.js"] } },
  };

  // When only db is relaunched and the provider merges its record.
  const record = selectedAppliedRecord(desired, runtime, previous);
  const merged = mergeAppliedPlan(previous, record);

  // Then the published table keeps web's and gone's applied routes in applied order, then db's desired
  // routes; web's unapplied edit is never in it.
  expect(record.routes.map((route) => route.hostname)).toEqual([
    "web.test",
    "gone.test",
    "db-new.test",
    "db-extra.test",
  ]);
  // And db records what was applied, while web and gone keep their applied command and policy.
  expect(record.fileSyncPolicy?.services).toEqual({ db: policy("accelerated") });
  expect(merged.services[db.name]?.command).toEqual(["node", "built.js"]);
  expect(merged.services[web.name]?.command).toEqual(["node", "old.js"]);
  expect(merged.fileSyncPolicy?.services).toEqual({
    web: policy("ordinary"),
    db: policy("accelerated"),
    gone: policy("ordinary"),
  });
  // And every service's route references point at the composed table.
  expect(hostnames(merged, web.name)).toEqual(["web.test"]);
  expect(hostnames(merged, db.name)).toEqual(["db-new.test", "db-extra.test"]);
  expect(hostnames(merged, gone.name)).toEqual(["gone.test"]);
});

test("drops the selected service's removed route and keeps unselected applied routes", () => {
  // Given an applied record with one route on each service.
  const previous = appWith("old.js", [routeTo(web, "web.test"), routeTo(db, "db.test")], [web, db]);
  // And a desired plan whose selected service no longer declares a route.
  const desired = appWith("new.js", [routeTo(web, "web.test")], [web, db]);
  const runtime: AppPlan = { ...desired, services: { [db.name]: desired.services[db.name] ?? db } };

  // When db is relaunched.
  const record = selectedAppliedRecord(desired, runtime, previous);
  const merged = mergeAppliedPlan(previous, record);

  // Then only web's applied route remains published and db records none.
  expect(record.routes.map((route) => route.hostname)).toEqual(["web.test"]);
  expect(hostnames(merged, web.name)).toEqual(["web.test"]);
  expect(hostnames(merged, db.name)).toEqual([]);
});

test("records the selected services' desired routes when no applied plan exists", () => {
  // Given a selected rebuild of an app that was never started, with an unselected service.
  const desired = appWith("new.js", [routeTo(web, "web.test"), routeTo(db, "db.test")], [web, db]);
  const runtime: AppPlan = { ...desired, services: { [web.name]: desired.services[web.name] ?? web } };

  // When its record is built without a previous applied plan.
  const record = selectedAppliedRecord(desired, runtime, undefined);

  // Then the table is just the selected service's desired routes and its references point there.
  expect(record.routes.map((route) => route.hostname)).toEqual(["web.test"]);
  expect(record.services[web.name]?.routes).toEqual([{ index: 0 }]);
  expect(record.services[db.name]).toBeUndefined();
});
