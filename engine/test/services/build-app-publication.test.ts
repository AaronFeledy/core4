import { expect, test } from "bun:test";
import { failureOutcomeFromCause } from "@lando/sdk/command-result";
import { EventError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Stream } from "effect";
import { EventDispatchScope } from "../../src/services/event-service.ts";
import { withTempRoots } from "./build-app-runner-test-support.ts";
import { captureBuild, retainedProvider, taskDispositions } from "./build-app-settlement-support.ts";

test.each([
  { event: "task.start", exitCode: 0, terminal: "task.fail", outcome: "fail", executions: 0, succeeded: 0 },
  {
    event: "task.complete",
    exitCode: 0,
    terminal: "task.complete",
    outcome: "complete",
    executions: 1,
    succeeded: 1,
  },
  { event: "task.fail", exitCode: 7, terminal: "task.fail", outcome: "fail", executions: 1, succeeded: 0 },
] as const)("settles once when $event delivery precedes a dispatcher failure", async (scenario) => {
  await withTempRoots(async () => {
    const publicationFailure = new EventError({
      event: scenario.event,
      message: "The delivered event's subscriber failed.",
      remediation: "Fix the event subscriber.",
    });
    let executions = 0;
    const provider = {
      ...retainedProvider,
      execStream: () => {
        executions += 1;
        return Stream.make({ exitCode: scenario.exitCode });
      },
    };

    const result = await Effect.runPromise(
      captureBuild(provider).pipe(
        Effect.provideService(EventDispatchScope, {
          hasSubscribers: (name) => name === scenario.event,
          dispatch: () => Effect.fail(publicationFailure),
        }),
      ),
    );

    taskDispositions(result.events, { "web:app:install": scenario.terminal });
    expect(executions).toBe(scenario.executions);
    expect(result.entries).toMatchObject([{ outcome: scenario.outcome }]);
    expect(result.events.filter((event) => event._tag === "task.tree.complete")).toMatchObject([
      { succeeded: scenario.succeeded, failed: 1 - scenario.succeeded, outcome: "failure" },
    ]);
    if (Exit.isSuccess(result.exit)) throw new TypeError("Publication failure unexpectedly recovered");
    expect(result.exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toContain(
      publicationFailure,
    );
    if (scenario.exitCode === 7)
      expect(failureOutcomeFromCause(result.exit.cause)).toMatchObject({
        error: { _tag: "BuildPhaseFailedError", failures: [{ exitCode: 7 }] },
        additionalErrors: [{ role: "cleanup", error: publicationFailure }],
      });
  });
});
