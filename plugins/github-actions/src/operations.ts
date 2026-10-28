import type { Effect } from "effect";
import type { GithubActionsWorkflowError } from "./errors.ts";
import { listWorkflowsFromInput } from "./list.ts";
import type { ListWorkflowsOptions, WorkflowInspection } from "./schema.ts";

export const listWorkflows = (
  options: ListWorkflowsOptions,
): Effect.Effect<WorkflowInspection, GithubActionsWorkflowError> => listWorkflowsFromInput(options);
