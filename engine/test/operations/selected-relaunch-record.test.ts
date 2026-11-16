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

test("records only the relaunched services and leaves the rest of the applied record as it was", () => {
  // Given an applied record whose web and db ran old.js behind web.test and db.test, plus a service
  // the Landofile has since dropped.
  const webRoute = routeTo(web, "web.test");
  const dbRoute = routeTo(db, "db.test");
  const previous: AppPlan = {
    ...appWith("old.js", [webRoute, dbRoute], [web, db, gone]),
    fileSyncPolicy: {
      reason: "service-opt-out",
      services: { web: policy("ordinary"), db: policy("ordinary"), gone: policy("ordinary") },
    },
  };
  // And a desired plan that changed both services, moved web to a new hostname, and gave db a second route.
  const desired: AppPlan = {
    ...appWith("new.js", [routeTo(web, "web-new.test"), dbRoute, routeTo(db, "db-extra.test")], [web, db]),
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

  // Then db records what was applied, while web keeps its applied command and policy.
  expect(record.fileSyncPolicy?.services).toEqual({ db: policy("accelerated") });
  expect(merged.services[db.name]?.command).toEqual(["node", "built.js"]);
  expect(merged.services[web.name]?.command).toEqual(["node", "old.js"]);
  expect(merged.fileSyncPolicy?.services).toEqual({
    web: policy("ordinary"),
    db: policy("accelerated"),
    gone: policy("ordinary"),
  });
  // And the routes stay as published: a selected relaunch publishes none, so web keeps web.test and
  // db keeps the route references it was applied with.
  const hostnames = (service: ServiceName) =>
    (merged.services[service]?.routes ?? []).map((ref) => merged.routes[ref.index]?.hostname);
  expect(hostnames(web.name)).toEqual(["web.test"]);
  expect(hostnames(db.name)).toEqual(["db.test"]);
  // And the dropped service stays as cleanup evidence.
  expect(merged.services[gone.name]?.command).toEqual(["node", "old.js"]);
});

test("records no routes when no applied plan exists", () => {
  // Given a selected rebuild of an app that was never started.
  const desired = appWith("new.js", [routeTo(web, "web.test")], [web]);

  // When its record is built without a previous applied plan.
  const record = selectedAppliedRecord(desired, desired, undefined);

  // Then no route is claimed as published.
  expect(record.routes).toEqual([]);
  expect(record.services[web.name]?.routes).toEqual([]);
});
