import { expect, test } from "bun:test";
import { buildMeasuredCommands } from "../../../scripts/workflow-performance-measurement.ts";
import { buildWorkflowPerformancePlan } from "../../../scripts/workflow-performance-plan.ts";

test("uses supported rebuild argv without a confirmation flag", () => {
  const lane = buildWorkflowPerformancePlan({ runId: "inputs" }).lanes.find(
    (lane) => lane.id === "unchanged-rebuild",
  );
  if (lane === undefined) throw new Error("missing rebuild lane");
  const commands = buildMeasuredCommands({ lane, binary: "/lando", appRoot: "/app", env: {} });
  expect(commands[0]?.argv).toEqual(["/lando", "rebuild"]);
});

test("enables closed failure evidence for every measured Lando command", () => {
  // Given every lane in the fixed workflow performance plan.
  const plan = buildWorkflowPerformancePlan({
    runId: "diagnostics",
    startSampleCount: 1,
    heavySampleCount: 1,
  });

  // When all measured commands are materialized.
  const commands = plan.lanes.flatMap((lane) =>
    buildMeasuredCommands({
      lane,
      binary: "/lando",
      appRoot: `/apps/${lane.id}`,
      fixturePath: "/fixtures/database.sql",
      env: { EXISTING: "value" },
    }),
  );

  // Then every Lando command enables the private closed cause channel without losing its environment.
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every((command) => command.argv[0] === "/lando")).toBe(true);
  expect(commands.every((command) => command.env.LANDO_DEBUG_CAUSE_CHAIN === "1")).toBe(true);
  expect(commands.every((command) => command.env.LANDO_RENDERER === "json")).toBe(true);
  expect(commands.every((command) => command.env.EXISTING === "value")).toBe(true);
});
