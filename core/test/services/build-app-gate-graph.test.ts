import { describe, expect, test } from "bun:test";

import type { DependencyPlan, ServicePlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";

import { buildAppGraph } from "../../src/services/build-app-graph.ts";
import { appSteps } from "../../src/services/build-app-plan.ts";
import { planWith } from "./build-app-runner-test-support.ts";

const dependency = (
  name: string,
  condition: DependencyPlan["condition"],
  required = true,
): DependencyPlan => ({ service: ServiceName.make(name), condition, required });

const dependsOn = (...dependencies: ReadonlyArray<DependencyPlan>): Partial<ServicePlan> => ({
  dependsOn: dependencies,
});

const install = (id = "install") => ({ id, phase: "app", command: { command: [id] } });

describe("buildAppGraph", () => {
  test("deduplicates a shared gate node while keeping required edge-local", () => {
    // Given
    const plan = planWith(
      { db: [], web: [install()], cache: [install()] },
      {
        web: dependsOn(dependency("db", "service_healthy", true)),
        cache: dependsOn(dependency("db", "service_healthy", false)),
      },
    );

    // When
    const result = buildAppGraph(plan, appSteps(plan));

    // Then
    if (result._tag !== "Graph") throw new TypeError("expected a graph");
    expect(result.graph.nodes.filter((node) => node.id === "gate:db:healthy")).toHaveLength(1);
    expect(result.graph.edges).toContainEqual({
      predecessor: "gate:db:healthy",
      dependent: "step:web:app:install",
      required: true,
    });
    expect(result.graph.edges).toContainEqual({
      predecessor: "gate:db:healthy",
      dependent: "step:cache:app:install",
      required: false,
    });
  });

  test("gates every app step of the dependent service", () => {
    // Given
    const plan = planWith(
      { db: [], web: [install("first"), install("second")] },
      { web: dependsOn(dependency("db", "service_completed_successfully")) },
    );

    // When
    const result = buildAppGraph(plan, appSteps(plan));

    // Then
    if (result._tag !== "Graph") throw new TypeError("expected a graph");
    expect(
      result.graph.edges
        .filter((edge) => edge.predecessor === "gate:db:completed")
        .map((edge) => edge.dependent),
    ).toEqual(["step:web:app:first", "step:web:app:second"]);
  });

  test("marks internal step edges required and emits them before gate edges", () => {
    // Given
    const plan = planWith(
      { db: [], web: [install("first"), install("second")] },
      { web: dependsOn(dependency("db", "service_started")) },
    );

    // When
    const result = buildAppGraph(plan, appSteps(plan));

    // Then
    if (result._tag !== "Graph") throw new TypeError("expected a graph");
    expect(result.graph.edges[0]).toEqual({
      predecessor: "step:web:app:first",
      dependent: "step:web:app:second",
      required: true,
    });
    expect(result.graph.edges.slice(1).every((edge) => edge.predecessor === "gate:db:running")).toBe(true);
  });

  test("creates no gate for a dependency the plan does not contain", () => {
    // Given
    const plan = planWith(
      { web: [install()] },
      { web: dependsOn(dependency("absent", "service_started", false)) },
    );

    // When
    const result = buildAppGraph(plan, appSteps(plan));

    // Then
    if (result._tag !== "Graph") throw new TypeError("expected a graph");
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["step:web:app:install"]);
    expect(result.graph.edges).toEqual([]);
  });

  test("reports a step cycle before building any gate nodes", () => {
    // Given
    const plan = planWith(
      {
        db: [],
        web: [
          { id: "prepare", phase: "app", command: { command: ["prepare"] }, dependsOn: ["install"] },
          { id: "install", phase: "app", command: { command: ["install"] } },
        ],
      },
      { web: dependsOn(dependency("db", "service_healthy")) },
    );

    // When
    const result = buildAppGraph(plan, appSteps(plan));

    // Then
    expect(result).toEqual({
      _tag: "Cycle",
      edges: ["web:app:prepare -> web:app:install", "web:app:install -> web:app:prepare"],
    });
  });
});
