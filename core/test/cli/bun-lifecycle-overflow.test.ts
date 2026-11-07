import { expect, test } from "bun:test";
import * as Events from "@lando/engine/services/event-service";
import { RedactionService } from "@lando/redaction/service";
import { EventService, ProcessRunner } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { ChildOutput, makeChildOutputPolicy } from "../../src/cli/child-output.ts";
import { bunSelfRun } from "../../src/cli/commands/bun-self-runner.ts";
import { processRunnerFor } from "../_support/process-runner.ts";

test("an observed exit still closes its Bun lifecycle when invocation collection overflows", async () => {
  const policy = makeChildOutputPolicy({ native: false, stdin: false, stream: undefined });
  const runner = processRunnerFor(() => Effect.succeed({ exitCode: 17, stdout: "x".repeat(600_000) }));
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        yield* bunSelfRun({ argv: ["first"] });
        yield* bunSelfRun({ argv: ["second"] });
      }).pipe(Effect.result);
      const events = yield* (yield* EventService).query("*");
      return { result, events };
    }).pipe(
      Effect.provideService(ProcessRunner, runner),
      Effect.provideService(ChildOutput, policy),
      Effect.provide(Layer.merge(Events.layer, RedactionService.layer)),
    ),
  );
  expect(outcome.result._tag).toBe("Failure");
  expect(outcome.events.map((event) => String(event._tag))).toEqual([
    "pre-bun-self-exec",
    "post-bun-self-exec",
    "pre-bun-self-exec",
    "post-bun-self-exec",
  ]);
  expect(outcome.events.filter((event) => String(event._tag) === "post-bun-self-exec")).toMatchObject([
    { exitCode: 17 },
    { exitCode: 17 },
  ]);
  expect(policy.output()?.chunks).toHaveLength(1);
});
