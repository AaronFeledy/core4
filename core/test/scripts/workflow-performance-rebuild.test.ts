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
