import { type Context, DateTime, Effect } from "effect";

import type { EventError } from "@lando/sdk/errors";
import {
  TaskCompleteEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import type { AbsolutePath, AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";

const timestamp = () => DateTime.unsafeMake(new Date().toISOString());

export interface BuildTaskProgress {
  readonly parentId: string;
  readonly startTree: Effect.Effect<void, EventError>;
  readonly startTask: (service: ServicePlan, transcriptPath: AbsolutePath) => Effect.Effect<void, EventError>;
  readonly completeTask: (
    service: ServicePlan,
    summary: string,
    durationMs: number,
  ) => Effect.Effect<void, EventError>;
  readonly failTask: (service: ServicePlan, durationMs: number) => Effect.Effect<void, EventError>;
  readonly completeTree: (durationMs: number) => Effect.Effect<void, EventError>;
  readonly failTree: (durationMs: number) => Effect.Effect<void, EventError>;
}

export const makeBuildTaskProgress = (
  events: Context.Tag.Service<typeof EventService>,
  plan: AppPlan,
): BuildTaskProgress => {
  const services = Object.values(plan.services);
  const parentId = `build-artifact-${String(plan.id)}`;
  let succeeded = 0;
  return {
    parentId,
    startTree: events.publish(
      TaskTreeStartEvent.make({
        parentId,
        label: `Building ${plan.name}`,
        children: services.map((service) => String(service.name)),
        mode: "list",
        timestamp: timestamp(),
      }),
    ),
    startTask: (service, transcriptPath) =>
      events.publish(
        TaskStartEvent.make({
          taskId: String(service.name),
          parentId,
          label: `Build ${String(service.name)}`,
          transcriptPath,
          timestamp: timestamp(),
        }),
      ),
    completeTask: (service, summary, durationMs) =>
      events
        .publish(
          TaskCompleteEvent.make({
            taskId: String(service.name),
            summary,
            durationMs,
            timestamp: timestamp(),
          }),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              succeeded += 1;
            }),
          ),
        ),
    failTask: (service, durationMs) =>
      events.publish(
        TaskFailEvent.make({
          taskId: String(service.name),
          summary: `Build ${String(service.name)} failed`,
          exitCode: 1,
          durationMs,
          timestamp: timestamp(),
        }),
      ),
    completeTree: (durationMs) =>
      events.publish(
        TaskTreeCompleteEvent.make({
          parentId,
          summary: `${plan.name} built`,
          succeeded: services.length,
          failed: 0,
          durationMs,
          timestamp: timestamp(),
        }),
      ),
    failTree: (durationMs) =>
      events.publish(
        TaskTreeCompleteEvent.make({
          parentId,
          summary: `${plan.name} build failed`,
          succeeded,
          failed: 1,
          durationMs,
          timestamp: timestamp(),
        }),
      ),
  };
};
