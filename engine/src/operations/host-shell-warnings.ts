import { MessageWarnEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type CommandWarning,
  type EventStep,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";
import { effectiveToolingForPlan } from "../planner/effective-tooling.ts";
import { RESERVED_EVENT_NAMES } from "../planner/event-names.ts";
import { hostEventCommands, hostToolingCommands } from "../planner/host-shell-issues.ts";
import { invocationAuthorityForPlan } from "../planner/invocation-authority.ts";
import { bunShellDialectIssues, describeBunShellIssue } from "../services/bun-shell-dialect.ts";

/**
 * Host tooling tasks and task-bracket event steps that Bun Shell can't run. Planning doesn't
 * fail on them, because they only run on request, so these warnings tell people early.
 */
export const selectHostShellWarnings = (plan: AppPlan): readonly CommandWarning[] => {
  const sites = invocationAuthorityForPlan(plan)?.sites ?? [];
  // Project steps keep their authored index so a warning points at `events.<name>[i]`.
  const taskHooks: Record<string, EventStep[]> = {};
  for (const [name, steps] of Object.entries(plan.events ?? {})) {
    if (RESERVED_EVENT_NAMES.has(name)) continue;
    const authored: EventStep[] = [];
    for (const step of steps) if (step.source === "project") authored[step.sourceIndex] = step.step;
    taskHooks[name] = authored;
  }
  return [
    ...hostToolingCommands(effectiveToolingForPlan(plan) ?? {}, sites),
    ...hostEventCommands(taskHooks, sites),
  ].flatMap((command) => {
    const issue = bunShellDialectIssues(command.command)[0];
    if (issue === undefined) return [];
    const path = formatValidationIssuePath(command.path);
    return [
      {
        code: "LANDO_HOST_SHELL_SYNTAX",
        message: `${path}: ${describeBunShellIssue(issue)} The command fails when it runs.`,
        remediation: `${issue.suggestion} Run lando app:config:lint to see every finding.`,
        context: { path },
      },
    ];
  });
};

/** Records each warning for machine output and, for people, prints it when an event bus is present. */
export const publishHostShellWarnings = Effect.fnUntraced(function* (plan: AppPlan) {
  const machineOutput = yield* commandWarningsUseMachineOutput;
  const events = Option.getOrUndefined(yield* Effect.serviceOption(EventService));
  for (const warning of selectHostShellWarnings(plan)) {
    yield* recordCommandWarning(warning);
    if (!machineOutput && events !== undefined)
      yield* events.publish(
        MessageWarnEvent.make({
          body: `${warning.message} ${warning.remediation}`,
          timestamp: yield* DateTime.now,
        }),
      );
  }
});
