import { Effect } from "effect";
import { WorkflowAcquisition } from "./acquisition.ts";
import { diagnostic, limits, location } from "./diagnostics.ts";
import type { GithubActionsWorkflowError } from "./errors.ts";
import { inspectWorkflow } from "./inspect.ts";
import { type InspectedWorkflow, type WorkflowInspection, decodeListWorkflowsOptions } from "./schema.ts";

const listWorkflowsWithAcquisition = Effect.fn("GithubActions.listWorkflows")(function* (
  input: unknown,
): Effect.fn.Return<WorkflowInspection, GithubActionsWorkflowError, WorkflowAcquisition> {
  const options = yield* decodeListWorkflowsOptions(input);
  const acquisition = yield* WorkflowAcquisition;
  const inventory = yield* acquisition.discover(options);
  const workflows: InspectedWorkflow[] = [];
  let remaining = limits.aggregateBytes;
  for (const name of inventory.names) {
    const empty = { source: location(name), triggers: [], jobs: [], diagnosticsTruncated: false };
    if (remaining === 0) {
      workflows.push({
        ...empty,
        status: "uninspected",
        diagnostics: [diagnostic("aggregate-limit", location(name))],
      });
      continue;
    }
    const acquired = yield* acquisition.read(inventory, name, remaining);
    remaining = Math.max(0, remaining - acquired.bytes);
    switch (acquired.status) {
      case "read":
        workflows.push(yield* inspectWorkflow(name, acquired.content));
        break;
      case "failed":
        workflows.push({
          ...empty,
          status: acquired.diagnostic.code === "aggregate-limit" ? "uninspected" : "failed",
          diagnostics: [acquired.diagnostic],
        });
        break;
      default: {
        const exhaustive: never = acquired;
        return exhaustive;
      }
    }
  }
  const summary = {
    discovered: workflows.length,
    inspected: workflows.filter((row) => row.status === "inspected").length,
    failed: workflows.filter((row) => row.status === "failed").length,
    uninspected: workflows.filter((row) => row.status === "uninspected").length,
  };
  return {
    workflows,
    summary,
    complete: summary.uninspected === 0,
    diagnosticsTruncated: workflows.some((row) => row.diagnosticsTruncated),
    assessment: "execution-unassessed",
  };
});

export const listWorkflowsFromInput = (
  input: unknown,
): Effect.Effect<WorkflowInspection, GithubActionsWorkflowError> =>
  listWorkflowsWithAcquisition(input).pipe(Effect.provide(WorkflowAcquisition.layer));
