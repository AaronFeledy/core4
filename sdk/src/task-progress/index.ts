/**
 * `@lando/sdk/task-progress` — shared task-tree publisher and controller.
 *
 * Long-running commands publish `task.tree.start` with child ids, then
 * `task.start` / `task.complete` / `task.fail` per child, then
 * `task.tree.complete`. This subpath is the same additive-Beta utility tier as
 * `@lando/sdk/probe`: it constructs no `LandoRuntime`, pulls no service
 * `Layer`, and imports only effect plus type-only sibling events/schema/services.
 * It is **not** a `Context.Tag` service and **not** a pluggable abstraction.
 *
 * Helpers serialize the existing task event schemas. They register no JSON
 * Schema and widen no frozen `@lando/sdk/errors` union.
 */
export type {
  ProgressEmitter,
  TaskCompleteArgs,
  TaskDetailArgs,
  TaskFailArgs,
  TaskStartArgs,
  TreeCompleteArgs,
  TreeStartArgs,
} from "./publish.ts";
export {
  publishTaskComplete,
  publishTaskDetail,
  publishTaskFail,
  publishTaskStart,
  publishTreeComplete,
  publishTreeStart,
} from "./publish.ts";
export type {
  MakeTaskTreeArgs,
  TaskFailOptions,
  TaskSpec,
  TaskStartOptions,
  TaskTreeController,
  TaskTreeSummaries,
} from "./controller.ts";
export { makeTaskTree, runWithTaskTree, startChildTaskId } from "./controller.ts";
