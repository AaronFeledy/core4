import { describe, expect, test } from "bun:test";
import {
  type AppPlan,
  CLONED_SERVICE_PROVENANCE_KEY,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import { selectRebuildPlan } from "../../src/operations/service-selection.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const service = (
  name: string,
  extras: Pick<Partial<ServicePlan>, "primary" | "dependsOn" | "provenance"> = {},
): ServicePlan => ({
  ...web,
  name: ServiceName.make(name),
  primary: extras.primary ?? false,
  endpoints: [],
  dependsOn: extras.dependsOn ?? [],
  ...(extras.provenance === undefined ? {} : { provenance: extras.provenance }),
});
const startedAfter = (parent: string) => [
  { service: ServiceName.make(parent), condition: "service_started" as const, required: true },
];
const companionOf = (parent: string): Partial<ServicePlan> => ({
  provenance: { [CLONED_SERVICE_PROVENANCE_KEY]: { feature: "schedule", from: parent } },
  dependsOn: startedAfter(parent),
});

// web depends on db; each has a generated companion; cache is unrelated.
const appPlan: AppPlan = {
  ...plan,
  services: Object.fromEntries(
    [
      service("cache"),
      service("db"),
      service("db-scheduler", companionOf("db")),
      service("web", { primary: true, dependsOn: startedAfter("db") }),
      service("web-scheduler", companionOf("web")),
    ].map((entry) => [entry.name, entry]),
  ),
};

const selected = (names: ReadonlyArray<string>) =>
  Effect.runSync(
    selectRebuildPlan(
      appPlan,
      names.map((name) => ServiceName.make(name)),
    ),
  );

describe("selectRebuildPlan", () => {
  test("adds the companions of selected prerequisites, in dependency order", () => {
    const names = Object.keys(selected(["web"]).services);
    expect(names.toSorted()).toEqual(["db", "db-scheduler", "web", "web-scheduler"]);
    expect(names.indexOf("db")).toBeLessThan(names.indexOf("web"));
    expect(names.indexOf("db")).toBeLessThan(names.indexOf("db-scheduler"));
  });

  test("a selected companion brings its parent and the parent's prerequisites", () => {
    expect(Object.keys(selected(["web-scheduler"]).services).toSorted()).toEqual([
      "db",
      "db-scheduler",
      "web",
      "web-scheduler",
    ]);
  });

  test("selecting a recorded selection again returns the same services", () => {
    const first = Object.keys(selected(["db"]).services);
    expect(Object.keys(selected(first).services)).toEqual(first);
  });
});
